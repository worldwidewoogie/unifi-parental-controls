"use strict"

const express = require('express')
const lib = require('./lib.js')

function getRouter() {
    var router = express.Router()
    router.route('/config').get(lib.httpGetConfig)
    router.route('/status').get(lib.httpGetStatus)
    router.route('/group/:groupName').post(lib.httpPostGroup)
    return router
}

module.exports.getRouter = getRouter