"use strict"

const unifi = require('node-unifi')
const schedule = require('node-schedule')
const config = require('./config.js')
const consoleStamp = require('console-stamp')

const daysToCrontab = {
    sunday: '0',
    monday: '1',
    tuesday: '2',
    wednesday: '3',
    thursday: '4',
    friday: '5',
    saturday: '6',
}

const groupsByID = { NOGROUP: 'NOGROUP' }
const groupsByName = { NOGROUP: 'NOGROUP' }
const deviceMacAddresses = {}
const deviceGroups = {}

function init() {
    return new Promise((resolve, reject) => {
        startCron().then(() => {
            resolve({ error: false })
        }).catch((error) => {
            reject({
                error: true,
                errorMessage: error
            })
        })
    })
}

module.exports.init = init

function startCron() {
    return new Promise((resolve, reject) => {
        recalculateCron().then(() => {
            console.log('Scheduling recalculateCron')
            schedule.scheduleJob('recalculateCron', '*/1 * * * *', () => {
                recalculateCron()
            })
            if (config.log.dumpSchedule) {
                console.log('Scheduling dumpSchedule')
                schedule.scheduleJob('dumpSchedule', config.log.dumpSchedule, () => {
                    Object.keys(schedule.scheduledJobs).forEach(jobName => {
                        console.log(jobName)
                    })
                })
            }
            if (config.log.dumpStatus) {
                console.log('Scheduling dumpStatus')
                schedule.scheduleJob('dumpStatus', config.log.dumpStatus, () => {
                    dumpStatus()
                })
            }
            resolve({
                error: false
            })
        }).catch((error) => {
            reject({
                error: true,
                errorMessage: error
            })
        })
    })
}

function recalculateCron(deviceGroup) {
    return new Promise((resolve, reject) => {
        //console.log('Recalculating cron schedule')
        getGroups().then(() => {
            getDeviceGroups().then(() => {
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
                                let [hour, minute] = Object.values(entry)[0].split(':')
                                let cronSchedule = minute + " " + hour + " * * " + daysToCrontab[day]
                                newSchedule.push(deviceMacAddresses[device] + '|' + cronSchedule + '|' + action)
                            })
                        })
                    }
                    let jobNamesToCancel = currentSchedule.filter(j => !newSchedule.includes(j))
                    let jobNamesToSchedule = newSchedule.filter(j => !currentSchedule.includes(j))
                    jobNamesToCancel.forEach(jobName => {
                        console.log('Canceling ' + jobName)
                        schedule.cancelJob(jobName)
                    })
                    jobNamesToSchedule.forEach(jobName => {
                        let [macAddress, cronSchedule, action] = jobName.split('|')
                        console.log('Scheduling ' + jobName)
                        if (action === 'block') {
                            schedule.scheduleJob(jobName, cronSchedule, () => {
                                console.log('Blocking ' + macAddress + ' due to schedule')
                                block(macAddress)
                            })
                        } else {
                            schedule.scheduleJob(jobName, cronSchedule, () => {
                                console.log('Unblocking ' + macAddress + ' due to schedule')
                                unblock(macAddress)
                            })
                        }
                    })
                    if (!config.controls.managedGroups[groupsByID[deviceGroups[device]]].enforceSchedule) {
                        console.log('Unblocking ' + deviceMacAddresses[device] + 'since it has no enforced schedule')
                        unblock(macAddressdeviceMacAddresses[device])
                    } else if (jobNamesToCancel.length > 0 || jobNamesToSchedule.length > 0) {
                        let date = new Date
                        let minutes = date.getMinutes()
                        let hour = date.getHours()
                        let dayOfWeek = date.getDay()
                        let currentJob = ''
                        newSchedule.forEach(s => {
                            let cronSchedule = s.split('|')[1]
                            let [m, h, x, y, w] = cronSchedule.split(' ')
                            if (w == dayOfWeek && (h < hour || (m <= minutes && h == hour))) {
                                currentJob = s
                            }
                        })
                        console.log("Current schedule : " + currentJob)
                        if (currentJob === '') {
                            console.log('Blocking ' + deviceMacAddresses[device] + ' since it has no current schedule')
                            block(macAddressdeviceMacAddresses[device])
                        } else {
                            let [macAddress, cronSchedule, action] = currentJob.split('|')
                            if (action === 'block') {
                                console.log('Blocking ' + deviceMacAddresses[device] + ' since current schedule is blocked')
                                block(macAddress)
                            } else {
                                console.log('Unblocking ' + deviceMacAddresses[device] + ' since current schedule is unblocked')
                                unblock(macAddress)
                            }
                        }
                    }
                })
                resolve({
                    error: false
                })
            })
        }).catch((error) => {
            reject({
                error: true,
                errorMessage: error
            })
        })
    })
}

function getGroups() {
    return new Promise((resolve, reject) => {
        let controller = new unifi.Controller(config.controller.ip, config.controller.port)
        controller.login(config.controller.username, config.controller.password, (error) => {
            if (error) {
                reject({
                    error: true,
                    errorMessage: "Error logging into controller: " + error
                })
            } else {
                controller.getUserGroups(config.controls.managedSite, (error, g) => {
                    if (error) {
                        reject({
                            error: true,
                            errorMessage: "Error getting current groups: " + error
                        })
                    } else {
                        if (g && g[0]) {
                            g[0].forEach(group => {
                                if (Object.keys(config.controls.managedGroups).includes(group.name)) {
                                    groupsByID[group._id] = group.name
                                    groupsByName[group.name] = group._id
                                } else {
                                    delete groupsByID[group._id]
                                    delete groupsByName[group.name]
                                }
                            })
                            resolve({
                                error: false
                            })
                        } else {
                            reject({
                                error: true,
                                errorMessage: "Error getting current groups: no groups returned"
                            })
                        }
                    }
                })
            }
        })
    })
}

function getDeviceGroups() {
    return new Promise((resolve, reject) => {
        let newDeviceGroups = {}
        let newDeviceMacAddresses = {}
        getCurrentlyConnectedDevicesForSSIDs().then((results) => {
            results.devices.forEach(device => {
                newDeviceGroups[device.id] = device.group
                newDeviceMacAddresses[device.id] = device.mac
            })
            getAllKnownDevicesInGroups().then((results) => {
                results.devices.forEach(device => {
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
                resolve({
                    error: false
                })
            }).catch((error) => {
                reject({
                    error: true,
                    errorMessage: error
                })
            })
        }).catch((error) => {
            reject({
                error: true,
                errorMessage: error
            })
        })
    })
}

function getCurrentlyConnectedDevicesForSSIDs() {
    return new Promise((resolve, reject) => {
        let devices = []
        let controller = new unifi.Controller(config.controller.ip, config.controller.port)
        controller.login(config.controller.username, config.controller.password, (error) => {
            if (error) {
                reject({
                    error: true,
                    errorMessage: "Error logging into controller: " + error
                })
            } else {
                controller.getClientDevices(config.controls.managedSite, (error, d) => {
                    if (error) {
                        reject({
                            error: true,
                            errorMessage: "Error getting client devices: " + error
                        })
                    } else {
                        if (d && d[0]) {
                            d[0].forEach(device => {
                                if (device.essid && config.controls.managedSSIDs.includes(device.essid)) {
                                    let tempDevice = {
                                        id: device._id,
                                        mac: device.mac,
                                    }
                                    if (device.usergroup_id) {
                                        tempDevice.group = device.usergroup_id
                                    } else {
                                        tempDevice.group = 'NOGROUP'
                                    }
                                    devices.push(tempDevice)
                                }
                            })
                            controller.logout()
                            resolve({
                                error: false,
                                devices: devices
                            })
                        } else {
                            reject({
                                error: true,
                                errorMessage: "Error getting currently connected devices: no devices returned"
                            })
                        }
                    }
                })
            }
        })
    })
}

function getAllKnownDevicesInGroups() {
    return new Promise((resolve, reject) => {
        let devices = []
        let controller = new unifi.Controller(config.controller.ip, config.controller.port)
        controller.login(config.controller.username, config.controller.password, (error) => {
            if (error) {
                reject({
                    error: true,
                    errorMessage: "Error logging into controller: " + error
                })
            } else {
                controller.getAllUsers(config.controls.managedSite, (error, d) => {
                    if (error) {
                        reject({
                            error: true,
                            errorMessage: "Error getting client devices: " + error
                        })
                    } else {
                        if (d && d[0]) {
                            d[0].forEach(device => {
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
                            controller.logout()
                            resolve({
                                error: false,
                                devices: devices
                            })
                        } else {
                            reject({
                                error: true,
                                errorMessage: "Error getting known devices: no devices returned"
                            })
                        }
                    }
                })
            }
        })
    })
}

function block(mac) {
    return new Promise((resolve, reject) => {
        let controller = new unifi.Controller(config.controller.ip, config.controller.port)
        controller.login(config.controller.username, config.controller.password, (error) => {
            if (error) {
                reject({
                    error: true,
                    errorMessage: "Error logging into controller: " + error
                })
            } else {
                // controller.blockClient(config.controls.managedSite, mac,  (error) =>{
                //     if (error) {
                //         reject({
                //             error: true,
                //             errorMessage: 'Error blocking ' + mac + ': ' + error
                //         })
                //     } else {
                controller.logout()
                console.log('Blocked ' + mac)
                resolve({
                    error: false,
                    status: 'Blocked ' + mac
                })
                //     }
                // })
            }
        })
    })
}

function unblock(mac) {
    return new Promise((resolve, reject) => {
        let controller = new unifi.Controller(config.controller.ip, config.controller.port)
        controller.login(config.controller.username, config.controller.password, (error) => {
            if (error) {
                reject({
                    error: true,
                    errorMessage: "Error logging into controller: " + error
                })
            } else {
                // controller.unblockClient(config.controls.managedSite, mac,  (error) => {
                //     if (error) {
                //         reject({
                //             error: true,
                //             errorMessage: 'Error unblocking ' + mac + ': ' + error
                //         })
                //     } else {
                controller.logout()
                console.log('Unblocked ' + mac)
                resolve({
                    error: false,
                    status: 'Unblocked ' + mac
                })
                //     }
                // })
            }
        })
    })
}

function getSingleStatus(deviceId) {
    return new Promise((resolve, reject) => {
        let controller = new unifi.Controller(config.controller.ip, config.controller.port)
        controller.login(config.controller.username, config.controller.password, (error) => {
            if (error) {
                reject({
                    error: true,
                    errorMessage: "Error logging into controller: " + error
                })
            } else {
                controller.getClientDevice(config.controls.managedSite, (error, d) => {
                    if (error) {
                        reject({
                            error: true,
                            errorMessage: "Error getting client device " + deviceMacAddresses[deviceId] + ": " + error
                        })
                    } else {
                        controller.logout()
                        if (d && d[0] && d[0][0]) {
                            let lastSchedule = ''
                            let nextSchedule = ''
                            if (groupsByID[d[0][0]._id] ? config.controls.managedGroups[groupsByID[d[0][0]._id]].enforceSchedule : config.controls.managedGroups['NOGROUP'].enforceSchedule) {
                                let date = new Date
                                let minutes = date.getMinutes()
                                let hour = date.getHours()
                                let dayOfWeek = date.getDay()
                                let currentSchedule = []
                                Object.keys(schedule.scheduledJobs).forEach(jobName => {
                                    if (jobName.split('|')[0] === d[0][0].mac) {
                                        currentSchedule.push(jobName)
                                    }
                                })
                                currentSchedule.forEach(s => {
                                    let cronSchedule = s.split('|')[1]
                                    let [m, h, x, y, w] = cronSchedule.split(' ')
                                    if (w == dayOfWeek && (h < hour || (m <= minutes && h == hour))) {
                                        lastSchedule = s
                                    } else {
                                        if (lastSchedule !== '' && nextSchedule === '') {
                                            nextSchedule = s
                                        }
                                    }
                                })
                                if (nextSchedule === '') {
                                    nextSchedule = currentSchedule[0]
                                }
                            }
                            let device = {
                                id: d[0][0]._id,
                                mac: d[0][0].mac,
                                oui: d[0][0].oui,
                                hostname: d[0][0].hostname ? d[0][0].hostname : '',
                                essid: d[0][0].essid ? d[0][0].essid : '',
                                ip: d[0][0].use_fixedip ? d[0][0].fixed_ip : d[0][0].ip,
                                name: d[0][0].name ? d[0][0].name : '',
                                blocked: d[0][0].blocked ? d[0][0].blocked : false,
                                group: d[0][0].usergroup_id ? groupsByID[d[0][0].usergroup_id] : 'NOGROUP',
                                enforceSchedule: groupsByID[d[0][0]._id] ? config.controls.managedGroups[groupsByID[d[0][0]._id]].enforceSchedule : config.controls.managedGroups['NOGROUP'].enforceSchedule,
                                lastSchedule: lastSchedule,
                                nextSchedule: nextSchedule,
                            }
                            resolve({
                                error: false,
                                device: device
                            })
                        } else {
                            reject({
                                error: true,
                                errorMessage: "Error getting client device " + deviceMacAddresses[deviceId] + ": device not found"
                            })
                        }
                    }
                }, deviceMacAddresses[deviceId])
            }
        })
    })
}

function getStatus() {
    return new Promise((resolve, reject) => {
        let promises = Object.keys(deviceMacAddresses).map(id => getSingleStatus(id))
        Promise.allSettled(promises).then((results) => {
            let r = {}
            results.forEach(result => {
                r[result.value.device.id] = result.value.device
            })
            resolve(r)
        }).catch((error) => {
            console.dir(error)
            reject({
                error: true,
                errorMessage: "Error getting all client devices: " + error
            })
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
            resolve({
                error: false
            })
        }).catch((error) => {
            reject({
                error: true,
                errorMessage: error
            })
        })
    })
}

function getConfig() {
    return new Promise((resolve, reject) => {
        let cleanConfig = config
        delete cleanConfig.controller.password
        Object.keys(cleanConfig.ui.users).forEach(u => {
            cleanConfig.ui.users[u] = '********'
        })
        resolve(cleanConfig)
    })
}

module.exports.getConfig = getConfig