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
    // if you do not want to manage a pihole instance, delete this section
    pihole: {
        // ip address or hostname for the pihole instance
        host: '192.168.1.2',
        // username of the OS user to run sqlite3 commands against the pihole db
        username: '<username>',
        // path to the ssh private key that will allow logins to the above user
        privateKey: './config/pihole.key',
        // if you run pihole in podman or docker, specify only one of these
        podmanCommand: '/usr/bin/podman',
        // dockerCommand: '/usr/bin/podman',
        // the container name if using podman or docker
        containerName: 'pihole',
        // the path to the shell
        bash: '/bin/bash',
        // the path to sqlite3
        sqliteCommand: '/usr/bin/sqlite3',
        // path to the pihole db
        dbPath: '/etc/pihole',
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
        // how often to recalc the schedule
        scheduleRecalc: '*/15 * * * *',
        // Unifi user groups to manage. Always either block or unblock each day at 00:00
        // If harsh is false, you can manually unblock a user and they will not be blocked
        // the next scheduled block
        // If harsh is true, the schedule is enforced each time it is recalculated, so you
        // cannot manually unblock the client
        managedGroups: {
            group1: {
                enforceSchedule: true,
                harsh: false,
                schedule: {
                    sunday: [
                        { block: '00:00' },
                        { unblock: '09:00' },
                        { block: '22:30' },
                    ],
                    monday: [
                        { block: '00:00' },
                        { unblock: '07:30' },
                        // example of changing pihole groups to block/enable access
                        {
                            pihole: {
                                time: '08:30',
                                groups: ['Default', 'NoYoutube', 'NoSteam', 'NoDiscord', 'NoSpotify']
                            }
                        },
                        {
                            pihole:
                            {
                                time: '14:30',
                                groups: ['Default']
                            }
                        },
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
                harsh: false,
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
                harsh: true,
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