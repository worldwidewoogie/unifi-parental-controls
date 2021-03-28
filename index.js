"use strict"

require('console-stamp')(console, { pattern: "yyyy-mm-dd HH:MM:ss.l" })
const lib = require('./lib.js')
const http = require('http')
const express = require('express')
const basicAuth = require('express-basic-auth')
const config = require('./config/config.js')

const port = config.port ? config.port : 8080
const router = require('./router.js')
const openHttpConnections = {}
const app = express()
const httpServer = http.Server(app)

process.on('uncaughtException', function (err) {
    console.error('Uncaught exception ', err)
    shutdown()
})

process.on('SIGTERM', function () {
    console.log('Received SIGTERM')
    shutdown()
})

process.on('SIGINT', function () {
    console.log('Received SIGINT')
    shutdown()
})

app.use(express.json())
app.use(express.urlencoded({ extended: true }))

app.use('/', basicAuth({ users: config.ui.users, challenge: true, realm: 'ParentalControls' }), router.getRouter())

app.listen(port, () => {
    console.log(`Listening on port ${port}`)
})

lib.init().catch((error) => {
    console.error(error)
    shutdown()
})

app.get('/ping', (req, res) => {
    res.json({ "status": "success" });
});

httpServer.on('connection', function (conn) {
    var key = conn.remoteAddress + ':' + (conn.remotePort || '');
    openHttpConnections[key] = conn;
    conn.on('close', function () {
        delete openHttpConnections[key]
    })
})

function shutdown() {
    console.log('Shutting down')
    console.log('Closing web server')
    for (var key in openHttpConnections) {
        openHttpConnections[key].destroy()
    }
    httpServer.close(function () {
        console.log('Web server closed')
    })
    process.exit(0)
}
