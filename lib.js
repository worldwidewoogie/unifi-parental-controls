"use strict"

const { NodeSSH } = require('node-ssh')
const unifiAxiosEvents = require('unifi-axios-events')
const schedule = require('node-schedule')
const config = require('./config/config.js')

const unifi = new unifiAxiosEvents(config.controller)
const ssh = new NodeSSH()

const piholeSql = {
    getAllGroups: 'select * from "group"',
    getAllClients: 'select * from client',
    getNextClientId: 'select max(id) + 1 from client',
    addClient: "insert into client (id, ip) values ({id}, '{ip}')",
    setClientGroups: 'delete from client_by_group where client_id = {clientId};insert into client_by_group (client_id, group_id) VALUES {values}',
}

const ipformat = /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/
const idformat = /^(0|[1-9]\d*)$/

const piholeCommands = {}

Object.keys(piholeSql).forEach(command => {
    let splitOnSingle = piholeSql[command].split("'")
    for (let i = 0; i < splitOnSingle.length; i++) {
        splitOnSingle[i] = splitOnSingle[i].split('"').join(`\\"`)
    }
    piholeCommands[command] = `${config.pihole.bash} -c "echo '${splitOnSingle.join(`"'"`)}' | ${config.pihole.sqliteCommand} ${config.pihole.dbPath}/gravity.db"`
    if (config.pihole.podmanCommand) {
        piholeCommands[command] = `${config.pihole.podmanCommand} exec -it ${config.pihole.containerName} ${piholeCommands[command]}`
    } else if (config.pihole.dockerCommand) {
        piholeCommands[command] = `${config.pihole.dockerCommand} exec -it ${config.pihole.containerName} ${piholeCommands[command]}`
    }
})

const daysToCrontab = {
    sunday: '0',
    monday: '1',
    tuesday: '2',
    wednesday: '3',
    thursday: '4',
    friday: '5',
    saturday: '6',
}

const Strings = {
    createPiholeCommand: (() => {
        return (str, o) => {
            return str.replace(/{([^{]+)}/g, (ignore, key) => {
                return (key = o[key]) == null ? '' : key
            })
        }
    })()
}

String.prototype.createPiholeCommand = function (o) {
    return Strings.createPiholeCommand(this, o);
}

const groupsByID = { NOGROUP: 'NOGROUP' }
const groupsByName = { NOGROUP: 'NOGROUP' }
const piholeGroupsByName = {}
const piholeClientIdForMacAddress = {}
const deviceMacAddresses = {}
const deviceGroups = {}
const ipAddressForMac = {}
const macAddressForIp = {}

function init() {
    return new Promise((resolve, reject) => {
        unifi.init().then(() => {
            unifi.on('*.connected', data => {
                if (config.controls.managedSSIDs.includes(data.ssid)) {
                    console.log(`Recalculating schedule: ${data.msg}`)
                    recalculateCron()
                }
            })
            unifi.on('*.disconnected', data => {
                if (config.controls.managedSSIDs.includes(data.ssid)) {
                    console.log(`Recalculating schedule: ${data.msg}`)
                    recalculateCron()
                }
            })
            startCron().then(() => {
                resolve(true)
            }).catch((error) => {
                reject(error)
            })
        })
    })
}

module.exports.init = init

function startCron() {
    return new Promise((resolve, reject) => {
        recalculateCron().then(() => {
            console.log(`Scheduling recalculateCron: ${config.controls.scheduleRecalc}`)
            schedule.scheduleJob('recalculateCron', config.controls.scheduleRecalc, () => {
                recalculateCron().catch((error) => {
                    console.error(`Error recalculating cron: ${error}`)
                })
            })
            if (config.log.dumpSchedule) {
                console.log(`Scheduling dumpSchedule: ${config.log.dumpSchedule}`)
                schedule.scheduleJob('dumpSchedule', config.log.dumpSchedule, () => {
                    Object.keys(schedule.scheduledJobs).forEach(jobName => {
                        console.log(jobName)
                    })
                })
            }
            if (config.log.dumpStatus) {
                console.log(`Scheduling dumpStatus: ${config.log.dumpStatus}`)
                schedule.scheduleJob('dumpStatus', config.log.dumpStatus, () => {
                    dumpStatus()
                })
            }
            resolve(true)
        }).catch((error) => {
            reject(error)
        })
    })
}

function recalculateCron(deviceGroup) {
    return new Promise((resolve, reject) => {
        console.log('Recalculating cron schedule')
        getGroups().then(() => {
            getDeviceGroups().then(() => {
                piholeGetClients().then(() => {
                    piholeGetGroups().then(() => {
                        let d = []
                        if (deviceGroup) {
                            d = [deviceGroup]
                        } else {
                            d = Object.keys(deviceGroups)
                        }
                        d.forEach(device => {
                            let currentSchedule = []
                            let newSchedule = []
                            Object.keys(schedule.scheduledJobs).forEach(jobName => {
                                if (jobName.split('|')[0] === deviceMacAddresses[device]) {
                                    currentSchedule.push(jobName)
                                }
                            })
                            if (config.controls.managedGroups[groupsByID[deviceGroups[device]]].enforceSchedule) {
                                let s = config.controls.managedGroups[groupsByID[deviceGroups[device]]].schedule
                                Object.keys(s).forEach(day => {
                                    s[day].forEach(entry => {
                                        let action = Object.keys(entry)[0]
                                        let hour
                                        let minute
                                        let parameters = []
                                        if (action === 'pihole') {
                                            [hour, minute] = Object.values(entry)[0].time.split(':')
                                            parameters = Object.values(entry)[0].groups.join('~')
                                        } else {
                                            [hour, minute] = Object.values(entry)[0].split(':')
                                        }
                                        let cronSchedule = minute + " " + hour + " * * " + daysToCrontab[day]
                                        newSchedule.push(`${deviceMacAddresses[device]}|${cronSchedule}|${action}|${parameters}`)
                                    })
                                })
                            }
                            let jobNamesToCancel = currentSchedule.filter(j => !newSchedule.includes(j))
                            let jobNamesToSchedule = newSchedule.filter(j => !currentSchedule.includes(j))
                            jobNamesToCancel.forEach(jobName => {
                                console.log(`Canceling ${jobName}`)
                                schedule.cancelJob(jobName)
                            })
                            jobNamesToSchedule.forEach(jobName => {
                                let [macAddress, cronSchedule, action, parameters] = jobName.split('|')
                                console.log(`Scheduling ${jobName}`)
                                if (action === 'block') {
                                    schedule.scheduleJob(jobName, cronSchedule, () => {
                                        console.log(`Blocking ${mac} due to schedule`)
                                        block(macAddress).then(message => {
                                            console.log(message)
                                        }).catch(error => {
                                            console.error(`Error blocking ${macAddress}: ${error}`)
                                        })
                                    })
                                } else if (action === 'unblock') {
                                    schedule.scheduleJob(jobName, cronSchedule, () => {
                                        console.log(`Unblocking ${macAddress} due to schedule`)
                                        unblock(macAddress).then(message => {
                                            console.log(message)
                                        }).catch(error => {
                                            console.error(`Error unblocking ${macAddress}: ${error}`)
                                        })
                                    })
                                } else if (action === 'pihole') {
                                    piholeGetClientId(macAddress).then(clientId => {
                                        schedule.scheduleJob(jobName, cronSchedule, () => {
                                            let groups = parameters.split('~')
                                            console.log(`Setting ${macAddress} to pihole groups [${groups.join(', ')}] due to schedule`)
                                            piholeSetGroups(macAddress, groups).then(message => {
                                                console.log(message)
                                            }).catch(error => {
                                                console.error(`Error setting ${macAddress} to pihole groups [${groups.join(', ')}]: ${error}`)
                                            })
                                        })
                                    }).catch(error => {
                                        console.log(`Not scheduling: ${jobName}`)
                                        console.log(`No pihole client id for ${macAddress}: ${error}`)
                                    })
                                }
                            })
                            if (config.controls.managedGroups[groupsByID[deviceGroups[device]]].enforceSchedule
                                && (jobNamesToCancel.length > 0 || jobNamesToSchedule.length > 0)) {
                                let currentDate = new Date
                                let currentMinutes = currentDate.getMinutes()
                                let currentHour = currentDate.getHours()
                                let currentDayOfWeek = currentDate.getDay()
                                let currentCronSchedule = currentMinutes + " " + currentHour + " * * " + daysToCrontab[currentDayOfWeek]
                                let lastPiholeSchedule = ''
                                let lastBlockOrUnblockSchedule = ''
                                let testSchedule = [...newSchedule]
                                testSchedule.push(`${deviceMacAddresses[device]}|${currentCronSchedule}|CURRENT|`)
                                testSchedule.sort((a, b) => {
                                    let [am, ah, ax, ay, aw] = a.split('|')[1].split(' ')
                                    let [bm, bh, bx, by, bw] = b.split('|')[1].split(' ')
                                    aw = ((6 - currentDayOfWeek) + aw) % 7
                                    bw = ((6 - currentDayOfWeek) + bw) % 7
                                    if (aw == bw && ah == bh) {
                                        return (am - bm)
                                    } else if (aw == bw) {
                                        return (ah - bh)
                                    } else {
                                        return (aw - bw)
                                    }
                                })
                                testSchedule.some(s => {
                                    let [m, c, a, p] = s.split('|')
                                    if (a === 'CURRENT') {
                                        return
                                    } else if (a === 'pihole') {
                                        lastPiholeSchedule = s
                                    } else {
                                        lastBlockOrUnblockSchedule = s
                                    }
                                })
                                console.log(`Current block schedule : ${lastBlockOrUnblockSchedule}`)
                                if (lastBlockOrUnblockSchedule === '') {
                                    console.log(`Blocking ${deviceMacAddresses[device]} since it has no current schedule`)
                                    block(deviceMacAddresses[device])
                                } else {
                                    let [macAddress, cronSchedule, action, parameters] = lastBlockOrUnblockSchedule.split('|')
                                    if (action === 'block') {
                                        if (config.controls.managedGroups[groupsByID[deviceGroups[device]]].harsh) {
                                            console.log(`Blocking ${macAddress} since current schedule is blocked`)
                                            block(macAddress).then(message => {
                                                console.log(message)
                                            }).catch(error => {
                                                console.error(`Error blocking ${macAddress}: ${error}`)
                                            })
                                        } else {
                                            console.log(`Not blocking ${macAddress} since enforcement is not harsh`)
                                        }
                                    } else {
                                        console.log(`Unblocking ${macAddress} since current schedule is unblocked`)
                                        unblock(macAddress).then(message => {
                                            console.log(message)
                                        }).catch(error => {
                                            console.error(`Error unblocking ${macAddress}: ${error}`)
                                        })
                                    }
                                }
                                if (config.pihole) {
                                    let [macAddress, cronSchedule, action, parameters] = lastPiholeSchedule.split('|')
                                    if (lastPiholeSchedule === '') {
                                        console.log(`No pihole schedule for ${deviceMacAddresses[device]}`)
                                    } else {
                                        console.log(`Current pihole schedule : ${lastPiholeSchedule}`)
                                        let groups = parameters.split('~')
                                        console.log(`Setting ${macAddress} to pihole groups [${groups.join(', ')}] since current schedule is [${groups.join(', ')}]`)
                                        piholeSetGroups(macAddress, groups).then(message => {
                                            console.log(message)
                                        }).catch(error => {
                                            console.error(`Error setting ${macAddress} to pihole groups [${groups.join(', ')}]: ${error}`)
                                        })
                                    }
                                }
                            }
                        })
                        resolve(true)
                    }).catch((error) => {
                        reject(error)
                    })
                }).catch((error) => {
                    reject(error)
                })
            }).catch((error) => {
                reject(error)
            })
        }).catch((error) => {
            reject(error)
        })
    })
}

function piholeGetClients() {
    return new Promise((resolve, reject) => {
        if (config.pihole) {
            piholeExecCommand('getAllClients').then(response => {
                if (response) {
                    response.forEach(clientData => {
                        let [id, ip] = clientData.split('|')
                        if (macAddressForIp[ip]) {
                            piholeClientIdForMacAddress[macAddressForIp[ip]] = id
                        }
                    })
                }
                resolve(true)
            }).catch((error) => {
                reject(error)
            })
        } else {
            resolve(true)
        }
    })
}

function piholeGetGroups() {
    return new Promise((resolve, reject) => {
        if (config.pihole) {
            piholeExecCommand('getAllGroups').then(response => {
                if (response) {
                    response.forEach(groupData => {
                        let [id, skip, name] = groupData.split('|')
                        piholeGroupsByName[name] = id
                    })
                }
                resolve(true)
            }).catch((error) => {
                reject(error)
            })
        } else {
            resolve(true)
        }
    })
}

function getGroups() {
    return new Promise((resolve, reject) => {
        unifi.get('list/usergroup').then(response => {
            if (response.data) {
                response.data.forEach(group => {
                    if (Object.keys(config.controls.managedGroups).includes(group.name)) {
                        groupsByID[group._id] = group.name
                        groupsByName[group.name] = group._id
                    } else {
                        delete groupsByID[group._id]
                        delete groupsByName[group.name]
                    }
                })
            }
            resolve(true)
        }).catch((error) => {
            reject(error)
        })
    })
}

function getDeviceGroups() {
    return new Promise((resolve, reject) => {
        let newDeviceGroups = {}
        let newDeviceMacAddresses = {}

        getCurrentlyConnectedDevicesForSSIDs().then((devices) => {
            devices.forEach(device => {
                newDeviceGroups[device.id] = device.group
                newDeviceMacAddresses[device.id] = device.mac
                ipAddressForMac[device.mac] = device.ip
                macAddressForIp[device.ip] = device.mac
            })
            getAllKnownDevicesInGroups().then((devices) => {
                devices.forEach(device => {
                    if (!Object.keys(deviceGroups).includes(device.id)) {
                        newDeviceGroups[device.id] = device.group
                        newDeviceMacAddresses[device.id] = device.mac
                    }
                })
                Object.keys(newDeviceMacAddresses).forEach(id => {
                    deviceGroups[id] = newDeviceGroups[id]
                    deviceMacAddresses[id] = newDeviceMacAddresses[id]
                })
                let devicesToRemove = Object.keys(deviceMacAddresses).filter(d => !Object.keys(newDeviceMacAddresses).includes(d))
                devicesToRemove.forEach(id => {
                    delete deviceGroups[id]
                    delete deviceMacAddresses[id]
                })
                resolve(true)
            }).catch((error) => {
                reject(error)
            })
        }).catch((error) => {
            reject(error)
        })
    })
}

function getCurrentlyConnectedDevicesForSSIDs() {
    return new Promise((resolve, reject) => {
        let devices = []
        unifi.get('stat/sta').then(response => {
            if (response.data) {
                response.data.forEach(device => {
                    if (device.essid && config.controls.managedSSIDs.includes(device.essid)) {
                        let tempDevice = {
                            id: device._id,
                            mac: device.mac,
                            ip: device.ip
                        }
                        if (device.usergroup_id) {
                            tempDevice.group = device.usergroup_id
                        } else {
                            tempDevice.group = 'NOGROUP'
                        }
                        devices.push(tempDevice)
                    }
                })
            }
            resolve(devices)
        }).catch((error) => {
            reject(error)
        })
    })
}

function getAllKnownDevicesInGroups() {
    return new Promise((resolve, reject) => {
        let devices = []
        unifi.get('stat/alluser').then(response => {
            if (response.data) {
                response.data.forEach(device => {
                    if (device.usergroup_id && groupsByID[device.usergroup_id]) {
                        let tempDevice = {
                            id: device._id,
                            mac: device.mac,
                            hostname: device.hostname,
                            group: device.usergroup_id,
                        }
                        if (device.note) {
                            tempDevice.note = device.note
                        }
                        devices.push(tempDevice)
                    }
                })
            }
            resolve(devices)
        }).catch((error) => {
            reject(error)
        })
    })
}

function block(mac) {
    return new Promise((resolve, reject) => {
        // unifi.post('cmd/stamgr', { cmd: 'block-sta', mac: mac.toLowerCase() }
        // ).then(() => {
        resolve(`Blocked ${mac}`)
        // }).catch((error) => {
        //     reject(error)
        // })
    })
}

function unblock(mac) {
    return new Promise((resolve, reject) => {
        // unifi.post('cmd/stamgr', { cmd: 'unblock-sta', mac: mac.toLowerCase() }
        // ).then(() => {
        resolve(`Unblocked ${mac}`)
        // }).catch((error) => {
        //     reject(error)
        // })
    })
}

function piholeGetClientId(mac) {
    return new Promise((resolve, reject) => {
        if (piholeClientIdForMacAddress[mac]) {
            resolve(piholeClientIdForMacAddress[mac])
        } else {
            if (ipAddressForMac[mac] && ipformat.test(ipAddressForMac[mac])) {
                piholeExecCommand('getNextClientId').then(id => {
                    if (idformat.test(id)) {
                        piholeClientIdForMacAddress[mac] = id
                        piholeExecCommand('addClient', { id: id, ip: ipAddressForMac[mac] }).then(response => {
                            resolve(true)
                        }).catch((error) => {
                            reject(error)
                        })
                    } else {
                        reject(`No valid pihole client id for ${mac}`)
                    }
                }).catch((error) => {
                    reject(error)
                })
            } else {
                reject(`No valid ip address for ${mac}`)
            }
        }
    })
}

function piholeSetGroups(mac, groups) {
    return new Promise((resolve, reject) => {
        if (piholeClientIdForMacAddress[mac]) {
            let values = []
            for (let i = 0; i < groups.length; i++) {
                if (piholeGroupsByName[groups[i]]) {
                    values.push(`(${piholeClientIdForMacAddress[mac]}, ${piholeGroupsByName[groups[i]]})`)
                } else {
                    console.warn(`Not adding ${mac} to pihole group${groups[i]}: no group id found`)
                }
            }
            piholeExecCommand('setClientGroups', { clientId: piholeClientIdForMacAddress[mac], values: values.join(', ') }).then(() => {
                resolve(`Set ${mac} to pihole groups [${groups.join(', ')}]`)
            }).catch(error => {
                reject(error)
            })
        } else {
            reject(`No valid pihole client id for ${mac}`)
        }
    })
}

function ensureSshConnected() {
    return new Promise((resolve, reject) => {
        if (ssh.isConnected()) {
            resolve(true)
        } else {
            ssh.connect(config.pihole).then(() => {
                resolve(true)
            }).catch(error => {
                reject(error)
            })
        }
    })
}

function piholeExecCommand(command, parameters) {
    return new Promise((resolve, reject) => {
        ensureSshConnected().then(() => {
            ssh.execCommand(piholeCommands[command].createPiholeCommand(parameters), { cwd: '/' }).then(result => {
                if (result.stderr && result.stderr !== '') {
                    reject(result.stderr)
                } else {
                    resolve(result.stdout.split('\r\n'))
                }
            }).catch(error => {
                reject(error)
            })
        }).catch(error => {
            reject(error)
        })
    })
}

function getSingleStatus(deviceId) {
    return new Promise((resolve, reject) => {
        unifi.get('stat/user/' + deviceMacAddresses[deviceId].toLowerCase()).then(response => {
            if (response.data && response.data[0]) {
                let lastschedule = ''
                let nextschedule = ''
                if (groupsByID[response.data[0]._id] ? config.controls.managedGroups[groupsByID[response.data[0]._id]].enforceSchedule : config.controls.managedGroups['NOGROUP'].enforceSchedule) {
                    let date = new Date
                    let minutes = date.getMinutes()
                    let hour = date.getHours()
                    let dayOfWeek = date.getDay()
                    let currentSchedule = []
                    Object.keys(schedule.scheduledJobs).forEach(jobName => {
                        if (jobName.split('|')[0] === response.data[0].mac) {
                            currentSchedule.push(jobName)
                        }
                    })
                    currentSchedule.forEach(s => {
                        let cronSchedule = s.split('|')[1]
                        let [m, h, x, y, w] = cronSchedule.split(' ')
                        if (w == dayOfWeek && (h < hour || (m <= minutes && h == hour))) {
                            lastschedule = s
                        } else {
                            if (lastschedule !== '' && nextschedule === '') {
                                nextschedule = s
                            }
                        }
                    })
                    if (nextschedule === '') {
                        nextschedule = currentSchedule[0]
                    }
                }
                let device = {
                    id: response.data[0]._id,
                    mac: response.data[0].mac,
                    oui: response.data[0].oui,
                    hostname: response.data[0].hostname ? response.data[0].hostname : '',
                    essid: response.data[0].essid ? response.data[0].essid : '',
                    ip: response.data[0].use_fixedip ? response.data[0].fixed_ip : response.data[0].ip,
                    name: response.data[0].name ? response.data[0].name : '',
                    blocked: response.data[0].blocked ? response.data[0].blocked : false,
                    group: response.data[0].usergroup_id ? groupsByID[response.data[0].usergroup_id] : 'NOGROUP',
                    enforceSchedule: groupsByID[response.data[0]._id] ? config.controls.managedGroups[groupsByID[response.data[0]._id]].enforceSchedule : config.controls.managedGroups['NOGROUP'].enforceSchedule,
                    harsh: groupsByID[response.data[0]._id] ? config.controls.managedGroups[groupsByID[response.data[0]._id]].harsh : false,
                    lastschedule: lastschedule,
                    nextschedule: nextschedule,
                }
                resolve(device)
            } else {
                reject(`Error getting client device ${deviceMacAddresses[deviceId]}: device not found`)
            }
        }).catch((error) => {
            console.error(error)
            reject(`Error getting all client devices ${deviceMacAddresses[deviceId]}: error`)
        })
    })
}

function getStatus() {
    return new Promise((resolve, reject) => {
        let promises = Object.keys(deviceMacAddresses).map(id => getSingleStatus(id))
        Promise.allSettled(promises).then((results) => {
            let r = {}
            results.forEach(result => {
                if (result.status === 'fulfilled') {
                    r[result.value.id] = result.value
                }
            })
            resolve(r)
        }).catch((error) => {
            console.error(error)
            reject(`Error getting all client devices: ${error}`)
        })
    })
}

module.exports.getStatus = getStatus

function dumpStatus() {
    return new Promise((resolve, reject) => {
        getStatus().then((results) => {
            Object.keys(results).forEach(r => {
                console.log(JSON.stringify(results[r]))
            })
            resolve(true)
        }).catch((error) => {
            reject(error)
        })
    })
}

function getCleanConfig() {
    return new Promise((resolve, reject) => {
        let cleanConfig = JSON.parse(JSON.stringify(config));
        delete cleanConfig.controller.password
        Object.keys(cleanConfig.ui.users).forEach(u => {
            cleanConfig.ui.users[u] = '********'
        })
        resolve(cleanConfig)
    })
}

module.exports.getCleanConfig = getCleanConfig
