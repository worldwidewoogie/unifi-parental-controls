# unifi-parental-controls

unifi-parental-controls uses Unifi user groups to block/unblock client devices on a schedule. That is all it does at this point, but I'm looking to add more features if/when I can figure out the APIs to support them. That likely means no policy based blocking of classes of sites, since Unifi does not currently support policy based routing.

[![License][mit-badge]][mit-url]

## Requirements

* Node.js v6 or later
* [UniFi-Controller](https://www.ubnt.com/download/unifi) v5

## Installation

The easiest way to run unifi-parental-controls is in a container.

Create a config file in a directory the container can access and do the following:

```
$ podman pull worldwidewoogie/unifi-parental-controls
$ podman run \
          --name parental-controls \
          -p <host port>:8080 \
          -v <path to config directory>:/node/config/ \
          worldwidewoogie/unifi-parental-controls
````

or

```
$ docker pull worldwidewoogie/unifi-parental-controls
$ docker run \
          --name parental-controls \
          -p <host port>:8080 \
          -v <path to config directory>:/node/config/ \
          worldwidewoogie/unifi-parental-controls
````

If you would like to run it directly in node, you can do the following:

```
$ git clone https://github.com/worldwidewoogie/unifi-parental-controls.git`
$ cd unifi-parental-controls
$ cp config/config-example.js config/config.js
```
Edit config/config.js to suit your needs

`$ node index.js`

Right now, the only documentation for config.js is in [config-example.js](config/config.js) is in the file itself.

This is a work in progress. Hopefully that will mean better documentation at some point.

## License

* MIT © 2021 woogie (https://github.com/worldwidewoogie)

[mit-badge]: https://img.shields.io/badge/License-MIT-blue.svg?style=flat
[mit-url]: LICENSE
