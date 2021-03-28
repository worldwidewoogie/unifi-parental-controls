"use strict"

const { NodeSSH } = require('node-ssh')
const unifiAxiosEvents = require('unifi-axios-events')
const schedule = require('node-schedule')
const config = require('./config/config.js')
const state = require('data-store')({ path: './config/state.json' })

// this will not save any changes when set to true
const debugOnly = config.debugOnly

if (!state.get('managedSite')
    && !state.get('managedSSIDs')
    && !state.get('managedGroups')
    && !state.get('scheduleRecalc')
    && !state.get('dumpStatus')
    && !state.get('dumpSchedule')
    && config.controls
    && config.log) {
    console.log('Migrating state from config.js to state.json. You can now remove the log and controls section of config.js.')
    state.set('managedSite', config.controls.managedSite)
    state.set('managedSSIDs', config.controls.managedSSIDs)
    state.set('managedGroups', config.controls.managedGroups)
    state.set('scheduleRecalc', config.controls.scheduleRecalc)
    state.set('dumpStatus', config.log.dumpStatus)
    state.set('dumpSchedule', config.log.dumpSchedule)
}

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

if (config.pihole) {
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
}

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
const groupNameForMac = {}
const ipAddressForMac = {}
const macAddressForIp = {}

function init() {
    return new Promise((resolve, reject) => {
        unifi.init().then(() => {
            unifi.on('*.connected', data => {
                if (state.get('managedSSIDs').includes(data.ssid)) {
                    console.log(`Recalculating schedule: ${data.msg}`)
                    recalculateCron()
                }
            })
            unifi.on('*.disconnected', data => {
                if (state.get('managedSSIDs').includes(data.ssid)) {
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
            console.log(`Scheduling recalculateCron: ${state.get('scheduleRecalc')}`)
            schedule.scheduleJob('recalculateCron', state.get('scheduleRecalc'), () => {
                recalculateCron().catch((error) => {
                    console.error(`Error recalculating cron: ${error}`)
                })
            })
            if (state.get('dumpSchedule')) {
                console.log(`Scheduling dumpSchedule: ${state.get('dumpSchedule')}`)
                schedule.scheduleJob('dumpSchedule', state.get('dumpSchedule'), () => {
                    Object.keys(schedule.scheduledJobs).forEach(jobName => {
                        console.log(jobName)
                    })
                })
            }
            if (state.get('dumpStatus')) {
                console.log(`Scheduling dumpStatus: ${state.get('dumpStatus')}`)
                schedule.scheduleJob('dumpStatus', state.get('dumpStatus'), () => {
                    dumpStatus()
                })
            }
            resolve(true)
        }).catch((error) => {
            reject(error)
        })
    })
}

function recalculateCron() {
    return new Promise((resolve, reject) => {
        console.log('Recalculating cron schedule')
        getGroups().then(() => {
            getDeviceGroups().then(() => {
                piholeGetClients().then(() => {
                    piholeGetGroups().then(() => {
                        let d = Object.keys(deviceGroups)
                        d.forEach(device => {
                            let currentSchedule = []
                            let newSchedule = []
                            Object.keys(schedule.scheduledJobs).forEach(jobName => {
                                if (jobName.split('|')[0] === deviceMacAddresses[device]) {
                                    currentSchedule.push(jobName)
                                }
                            })
                            if (state.get('managedGroups')[groupsByID[deviceGroups[device]]].enforceSchedule) {
                                let s = state.get('managedGroups')[groupsByID[deviceGroups[device]]].schedule
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
                                        let overrides = state.get('overrides')
                                        if (overrides && overrides[groupNameForMac[macAddress]].until === 'nextSchedule') {
                                            console.log(`Removing override for ${macAddress} due to nextSchedule`)
                                            delete (overrides[groupNameForMac[macAddress]])
                                            state.set('overrides', overrides)
                                        }
                                        console.log(`Blocking ${macAddress} due to schedule`)
                                        block(macAddress).then(message => {
                                            console.log(message)
                                        }).catch(error => {
                                            console.error(`Error blocking ${macAddress}: ${error}`)
                                        })
                                    })
                                } else if (action === 'unblock') {
                                    schedule.scheduleJob(jobName, cronSchedule, () => {
                                        let overrides = state.get('overrides')
                                        if (overrides && overrides[groupNameForMac[macAddress]].until === 'nextSchedule') {
                                            console.log(`Removing override for ${macAddress} due to nextSchedule`)
                                            delete (overrides[groupNameForMac[macAddress]])
                                            state.set('overrides', overrides)
                                        }
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
                            if (state.get('managedGroups')[groupsByID[deviceGroups[device]]].enforceSchedule
                                && (jobNamesToCancel.length > 0 || jobNamesToSchedule.length > 0)) {
                                let currentDate = new Date
                                let currentMinutes = currentDate.getMinutes()
                                let currentHour = currentDate.getHours()
                                let currentDayOfWeek = currentDate.getDay()
                                let currentCronSchedule = currentMinutes + " " + currentHour + " * * " + currentDayOfWeek
                                let lastPiholeSchedule = ''
                                let lastBlockOrUnblockSchedule = ''
                                let testSchedule = [...newSchedule]
                                testSchedule.push(`${deviceMacAddresses[device]}|${currentCronSchedule}|CURRENT|`)
                                testSchedule.sort((a, b) => {
                                    let [am, ah, ax, ay, aw] = a.split('|')[1].split(' ')
                                    let [bm, bh, bx, by, bw] = b.split('|')[1].split(' ')
                                    if (aw > currentDayOfWeek
                                        || (aw == currentDayOfWeek
                                            && (ah > currentHour
                                                || (ah == currentHour && am > currentMinutes)))
                                    ) {
                                        aw = aw - 7
                                    } 
                                    if (bw > currentDayOfWeek
                                        || (bw == currentDayOfWeek
                                            && (bh > currentHour
                                                || (bh == currentHour && bm > currentMinutes)))
                                    ) {
                                        bw = bw - 7
                                    } 
                                    if (aw == bw && ah == bh) {
                                        return (am - bm)
                                    } else if (aw == bw) {
                                        return (ah - bh)
                                    } else {
                                        return (aw - bw)
                                    }
                                })
                                console.dir(testSchedule)
                                testSchedule.some(s => {
                                    let [m, c, a, p] = s.split('|')
                                    if (a === 'CURRENT') {
                                        return true
                                    } else if (a === 'pihole') {
                                        lastPiholeSchedule = s
                                    } else {
                                        lastBlockOrUnblockSchedule = s
                                    }
                                })
                                console.log(`Current block schedule : ${lastBlockOrUnblockSchedule}`)
                                if (lastBlockOrUnblockSchedule === '') {
                                    console.log(`Blocking ${deviceMacAddresses[device]} since it has no current schedule`)
                                    block(deviceMacAddresses[device]).then(message => {
                                        console.log(message)
                                    }).catch(error => {
                                        console.error(`Error unblocking ${macAddress}: ${error}`)
                                    })
                                } else {
                                    let [macAddress, cronSchedule, action, parameters] = lastBlockOrUnblockSchedule.split('|')
                                    if (action === 'block') {
                                        console.log(`Blocking ${macAddress} since current schedule is blocked`)
                                        block(macAddress).then(message => {
                                            console.log(message)
                                        }).catch(error => {
                                            console.error(`Error blocking ${macAddress}: ${error}`)
                                        })
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
                    if (Object.keys(state.get('managedGroups')).includes(group.name)) {
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
                groupNameForMac[device.mac] = groupsByID[device.group]
            })
            getAllKnownDevicesInGroups().then((devices) => {
                devices.forEach(device => {
                    if (!Object.keys(deviceGroups).includes(device.id)) {
                        newDeviceGroups[device.id] = device.group
                        newDeviceMacAddresses[device.id] = device.mac
                        groupNameForMac[device.mac] = groupsByID[device.group]
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
                    if (device.essid && state.get('managedSSIDs').includes(device.essid)) {
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
        let overrides = state.get('overrides')
        if (overrides && Object.keys(overrides).includes(groupNameForMac[mac])
            && ['block', 'unblock'].includes(overrides[groupNameForMac[mac]].action)) {
            if (!debugOnly) {
                unifi.post('cmd/stamgr', { cmd: `${overrides[groupNameForMac[mac]].action}-sta`, mac: mac.toLowerCase() }
                ).then(() => {
                    resolve(`${mac} ${overrides[groupNameForMac[mac]].action}ed due to schedule override`)
                }).catch((error) => {
                    reject(error)
                })
            } else {
                resolve(`DEBUG: ${mac} ${overrides[groupNameForMac[mac]].action}ed due to schedule override`)
            }
        } else {
            if (!debugOnly) {
                unifi.post('cmd/stamgr', { cmd: 'block-sta', mac: mac.toLowerCase() }
                ).then(() => {
                    resolve(`Blocked ${mac}`)
                }).catch((error) => {
                    reject(error)
                })
            } else {
                resolve(`DEBUG: Would block ${mac}`)
            }
        }
    })
}

function unblock(mac) {
    return new Promise((resolve, reject) => {
        let overrides = state.get('overrides')
        if (overrides && Object.keys(overrides).includes(groupNameForMac[mac])
            && ['block', 'unblock'].includes(overrides[groupNameForMac[mac]].action)) {
            if (!debugOnly) {
                unifi.post('cmd/stamgr', { cmd: `${overrides[groupNameForMac[mac]].action}-sta`, mac: mac.toLowerCase() }
                ).then(() => {
                    resolve(`${mac} ${overrides[groupNameForMac[mac]].action}ed due to schedule override`)
                }).catch((error) => {
                    reject(error)
                })
            } else {
                resolve(`DEBUG: ${mac} ${overrides[groupNameForMac[mac]].action}ed due to schedule override`)
            }
        } else {
            if (!debugOnly) {
                unifi.post('cmd/stamgr', { cmd: 'unblock-sta', mac: mac.toLowerCase() }
                ).then(() => {
                    resolve(`Unblocked ${mac}`)
                }).catch((error) => {
                    reject(error)
                })
            } else {
                resolve(`DEBUG: Would unblock ${mac}`)
            }
        }
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
        let overrides = state.get('overrides')
        if (overrides && Object.keys(overrides).includes(groupNameForMac[mac])
            && overrides[groupNameForMac[mac]].piholeGroups) {
            if (!debugOnly) {
                if (piholeClientIdForMacAddress[mac]) {
                    let values = []
                    for (let i = 0; i < overrides[groupNameForMac[mac]].piholeGroups.length; i++) {
                        if (piholeGroupsByName[overrides[groupNameForMac[mac]].piholeGroups[i]]) {
                            values.push(`(${piholeClientIdForMacAddress[mac]}, ${piholeGroupsByName[overrides[groupNameForMac[mac]].piholeGroups[i]]})`)
                        } else {
                            console.warn(`Not adding ${mac} to pihole override group ${overrides[groupNameForMac[mac]].piholeGroups[i]}: no group id found`)
                        }
                    }
                    piholeExecCommand('setClientGroups', { clientId: piholeClientIdForMacAddress[mac], values: values.join(', ') }).then(() => {
                        resolve(`Set ${mac} to pihole groups [${groups.join(', ')}] due to override`)
                    }).catch(error => {
                        reject(error)
                    })
                } else {
                    reject(`No valid pihole client id for ${mac}`)
                }
            } else {
                resolve(`DEBUG: Would set ${mac} to pihole groups [${groups.join(', ')}] due to override`)
            }
        } else {
            if (!debugOnly) {
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
            } else {
                resolve(`DEBUG: Would set ${mac} to pihole groups [${groups.join(', ')}]`)
            }
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

function httpGetConfig(req, res, next) {
    getCleanConfig().then((results) => {
        res.json({ config: results, state: state.get() });
    }).catch(function (err) {
        console.dir(err)
        res.status(500).json({ "error": "Internal Server Error" })
    })
}

module.exports.httpGetConfig = httpGetConfig

function getSingleStatus(deviceId) {
    return new Promise((resolve, reject) => {
        unifi.get('stat/user/' + deviceMacAddresses[deviceId].toLowerCase()).then(response => {
            if (response.data && response.data[0]) {
                let lastschedule = ''
                let nextschedule = ''
                if (groupsByID[response.data[0]._id] ? state.get('managedGroups')[groupsByID[response.data[0]._id]].enforceSchedule : state.get('managedGroups')['NOGROUP'].enforceSchedule) {
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
                    enforceSchedule: groupsByID[response.data[0]._id] ? state.get('managedGroups')[groupsByID[response.data[0]._id]].enforceSchedule : state.get('managedGroups')['NOGROUP'].enforceSchedule,
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

function httpGetStatus(req, res, next) {
    getStatus().then((results) => {
        res.json(results);
    }).catch(function (err) {
        console.dir(err)
        res.status(500).json({ "error": "Internal Server Error" })
    })
}

module.exports.httpGetStatus = httpGetStatus

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

function httpPostGroup(req, res, next) {
    if (req.params
        && req.params.groupName
        && req.body
        && req.body.action
        && ['block', 'unblock', 'useSchedule'].includes(req.body.action)) {
        if (!req.body.piholeGroups || (Array.isArray(req.body.piholeGroups) && req.body.action === 'unblock')) {
            if (Object.keys(groupsByName).includes(req.params.groupName)) {
                let overrides = state.get('overrides')
                if (!overrides) {
                    overrides = {}
                }
                if (Object.keys(overrides).includes(req.params.groupName)) {
                    delete (overrides[req.params.groupName])
                }
                if (req.body.action !== 'useSchedule') {
                    let o = { action: req.body.action }
                    if (req.body.until && ['nextSchedule'].includes(req.body.until)) {
                        o.until = req.body.until
                    }
                    if (req.body.piholeGroups) {
                        o.piholeGroups = req.body.piholeGroups
                    }
                    overrides[req.params.groupName] = o
                }
                state.set('overrides', overrides)
                Object.keys(schedule.scheduledJobs).forEach(jobName => {
                    if (groupNameForMac[jobName.split('|')[0]] === req.params.groupName) {
                        console.log(`Canceling ${jobName} to recalculate for override`)
                        schedule.cancelJob(jobName)
                    }
                })
                recalculateCron().then(() => {
                    res.json({ 'status': 'success' })
                }).catch((error) => {
                    res.status(500).json({ 'error': `${error}` })
                })
            } else {
                res.status(404).json({ 'error': `No group named ${groupName}` })
            }
        } else {
            res.status(400).json({ 'error': 'piholeGroups can only be set when action is unblock and must be an array' })
        }
    } else {
        res.status(400).json({ 'error': 'groupName and action are required' })
    }
}

module.exports.httpPostGroup = httpPostGroup
