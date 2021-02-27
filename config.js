module.exports = {
    controller: {
        host: '192.168.1.1',
        port: '443',
        username: 'admin',
        password: '<password>',
        site: 'default',
        // allow self signed certs
        insecure: true
    },
    // credentials for the web ui
    ui: {
        users: {
            'admin': '<password>'
        }
    },
    // dump stats to the log on a periodic basis
    log: {
        dumpSchedule: '*/5 * * * *',
        dumpStatus: '*/15 * * * *',
    },
    controls: {
        // SSIDs to manage
        managedSSIDs: [
            'myssid',
            'myotherssid'
        ],
        // Unifi user groups to manage. Always either block or unblock each day at 00:00
        managedGroups: {
            group1: {
                enforceSchedule: true,
                schedule: {
                    sunday: [
                        { block: '00:00' },
                        { unblock: '09:00' },
                        { block: '22:30' },
                    ],
                    monday: [
                        { block: '00:00' },
                        { unblock: '07:30' },
                        { block: '22:30' },
                    ],
                    tuesday: [
                        { block: '00:00' },
                        { unblock: '07:30' },
                        { block: '22:30' },
                    ],
                    wednesday: [
                        { block: '00:00' },
                        { unblock: '07:30' },
                        { block: '22:30' },
                    ],
                    thursday: [
                        { block: '00:00' },
                        { unblock: '07:30' },
                        { block: '22:30' },
                    ],
                    friday: [
                        { block: '00:00' },
                        { unblock: '07:30' },
                        { block: '22:30' },
                    ],
                    saturday: [
                        { block: '00:00' },
                        { unblock: '09:00' },
                        { block: '22:30' },
                    ],
                },
            },
            group2: {
                enforceSchedule: true,
                schedule: {
                    sunday: [
                        { block: '00:00' },
                        { block: '22:30' },
                    ],
                    monday: [
                        { block: '00:00' },
                        { block: '22:30' },
                    ],
                    tuesday: [
                        { block: '00:00' },
                        { block: '22:30' },
                    ],
                    wednesday: [
                        { block: '00:00' },
                        { block: '22:30' },
                    ],
                    thursday: [
                        { block: '00:00' },
                        { block: '22:30' },
                    ],
                    friday: [
                        { block: '00:00' },
                        { block: '22:30' },
                    ],
                    saturday: [
                        { block: '00:00' },
                        { block: '22:30' },
                    ],
                },
            },
            guest: {
                enforceSchedule: false,
            },
            // schedule for clients not in any group. In this case they are always blocked.
            NOGROUP: {
                enforceSchedule: true,
                schedule: {
                    sunday: [
                        { block: '00:00' },
                    ],
                    monday: [
                        { block: '00:00' },
                    ],
                    tuesday: [
                        { block: '00:00' },
                    ],
                    wednesday: [
                        { block: '00:00' },
                    ],
                    thursday: [
                        { block: '00:00' },
                    ],
                    friday: [
                        { block: '00:00' },
                    ],
                    saturday: [
                        { block: '00:00' },
                    ],
                },
            }
        }
    }
}
