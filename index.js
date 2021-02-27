"use strict"

require('console-stamp')(console, { pattern: "yyyy-mm-dd HH:MM:ss.l" })
const lib = require('./lib.js')
const http = require('http')
const express = require('express')
const basicAuth = require('express-basic-auth')
const config = require('./config/config.js')

const app = express()
const port = 8080
const httpServer = http.Server(app)
const openHttpConnections = {}

app.use(basicAuth({ users: config.ui.users, challenge: true, realm: 'ParentalControls' }))

app.get('/config', (req, res) => {
    lib.getConfig().then((response) => {
        let html = '<!doctype html><html lang=en><head><meta charset=utf-8><title>config</title></head><body><pre>' +
            JSON.stringify(response, undefined, 4) +
            '</body></html>'
        res.send(html)
    })
})

app.get('/status', (req, res) => {
    lib.getStatus().then((response) => {
        let html = '<!doctype html><html lang=en><head><meta charset=utf-8><title>status</title></head><body><pre>' +
            JSON.stringify(response, undefined, 4) +
            '</body></html>'
        res.send(html)
    })
})

app.listen(port, () => {
    console.log(`Listening on http://localhost:${port}`)
})

lib.init()

httpServer.on('connection', function (conn) {
    var key = conn.remoteAddress + ':' + (conn.remotePort || '')
    openHttpConnections[key] = conn
    conn.on('close', function () {
        delete openHttpConnections[key]
    })
})

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

module.exports = app