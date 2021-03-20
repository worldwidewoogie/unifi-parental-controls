"use strict"

const express = require('express')
const lib = require('./lib.js')

function getRouter() {
    var router = express.Router()
    router.route('/status').get(lib.httpGetStatus)
    router.route('/config').get(lib.httpGetConfig)
    return router
}

module.exports.getRouter = getRouter