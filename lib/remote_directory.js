/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var EventEmitter = require('events').EventEmitter;
var util = require('util');
var assert = require('assert-plus');
var once = require('once');
var ldap = require('ldapjs');

///--- Globals

var CHANGELOG = 'cn=changelog';
var UFDS_UUID = 'cn=uuid';

///--- API

function RemoteDirectory(opts) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.object(opts.ldapConfig, 'opts.ldapConfig');
    assert.string(opts.ldapConfig.url, 'opts.ldapConfig.url');
    assert.arrayOfString(opts.ldapConfig.queries, 'opts.ldapConfig.queries');

    EventEmitter.call(this);
    var self = this;
    this.__defineGetter__('identity', function () {
        return {
            url: self.ldapConfig.url,
            uuid: self._uuid
        };
    });
    this.__defineGetter__('connected', function () {
        return self.client.connected;
    });

    this.log = opts.log;
    this.pollInterval = opts.pollInterval;
    this.queueSize = opts.queueSize;
    this.ldapConfig = opts.ldapConfig;
    this.rawQueries = opts.ldapConfig.queries;
    this._parseQueries(this.ldapConfig.queries);
}
util.inherits(RemoteDirectory, EventEmitter);
module.exports = RemoteDirectory;


/**
 * Initiate conncetion to remote UFDS instance.
 */
RemoteDirectory.prototype.connect = function connect() {
    if (this.client) {
        if (!this.client.destroyed) {
            this.client.connect();
        }
        return;
    }

    var self = this;
    var log = this.log;
    var config = this.ldapConfig;
    config.log = log;
    config.reconnect = config.reconnect || { maxDelay: 10000 };

    var client = ldap.createClient(config);
    client.on('setup', function (clt, next) {
        clt.bind(config.bindDN, config.bindCredentials, function (err) {
            if (err) {
                log.error({ bindDN: config.bindDN, err: err },
                    'invalid bind credentials');
            }
            next(err);
        });
    });
    // After a successful bind, query the UFDS version
    client.on('setup', function (clt, next) {
      var cb = once(function (err) {
        if (err) {
          self.log.error({err: err}, 'unable to query remote UFDS version');
        }
        next(err);
      });
      clt.search('', {scope: 'base'}, function (err, res) {
        if (err) {
          cb(err);
          return;
        }
        res.once('searchEntry', function (item) {
            var version = parseInt(item.object.morayVersion, 10);
            if (version > 0) {
                self.version = version;
                return cb();
            } else {
                // UFDS pre schema v17 did not have version information
                // It should be safe to report 17 as the version
                self.version = 17;
                return cb();
            }
        });
        res.once('error', cb);
      });
    });
    // Query UFDS instance uuid, if available
    client.on('setup', function (clt, next) {
        next = once(next);
        clt.search(UFDS_UUID, {scope: 'base'}, function (err, res) {
            if (err) {
                // treat send errors as more serious
                return next(err);
            }
            res.on('searchEntry', function (entry) {
                var obj = entry.object;
                if (obj.uuid) {
                    self._uuid = obj.uuid;
                }
            });

            // other errors aren't of concern for this
            res.on('error', next.bind(null, null));
            res.on('end', next.bind(null, null));
            return null;
        });
    });

    client.on('connect', function () {
        log.info({
          bindDN: config.bindDN,
          version: self.version
        }, 'connected and bound');
        self.emit('connect');
    });
    client.on('error', function (err) {
        log.warn(err, 'ldap error');
    });
    client.on('close', function () {
        if (!self.client.destroyed) {
            log.warn('ldap disconnect');
        }
    });
    client.on('resultError', function (err) {
        switch (err.name) {
        case 'UnavailableError':
        case 'BusyError':
            log.warn('ldap unavailable');
            self.client.unbind();
            break;
        default:
            // Other errors are not a centralized concern
            break;
        }
    });
    client.on('connectError', function (err) {
        log.warn(err, 'ldap connection attempt failed');
    });

    this.client = client;
};


/**
 * Poll for new changelog entries.
 *
 * Parameters:
 *  - start: Starting changenumber
 *  - end: Ending changenumber
 *  - result: Result callback
 *  - done: Completion callback
 */
RemoteDirectory.prototype.poll = function poll(start, end, result, done) {
    if (this.polling) {
        done();
        return;
    }
    var self = this;
    var cb = once(function (last) {
        self.polling = false;
        self.log.debug({last: last}, 'poll end');
        done(last);
    });
    this.polling = true;
    this.log.debug({start: start, end: end}, 'poll start');

    var filter = new ldap.AndFilter({
        filters: [
            new ldap.GreaterThanEqualsFilter({
                attribute: 'changenumber',
                value: start.toString()
            }),
            new ldap.LessThanEqualsFilter({
                attribute: 'changenumber',
                value: end.toString()
            })
        ]
    });
    var opts = {
        scope: 'sub',
        filter: filter
    };
    this.client.search(CHANGELOG, opts, function (err, res) {
        var last = 0;
        if (err) {
            self.warn({err: err}, 'error during changelog search');
            cb(last);
            return;
        }
        res.on('searchEntry', function (entry) {
            // Format the entry
            var data = entry.object;
            last = parseInt(data.changenumber, 10);
            try {
                var parsed = JSON.parse(data.changes);
                data.changes = parsed;
            } catch (e) {
                self.emit('error', e);
            }
            data.targetdn = ldap.parseDN(data.targetdn);

            var queries = self._matchQueries(data);
            if (queries.length > 0) {
                // Forward the filters downstream for del/mod changes
                data.queries = queries;
                result(data);
            }
        });
        res.on('end', function () {
            cb(last);
        });
        res.on('error', function (err2) {
            self.log.warn({err: err2}, 'error during search');
            cb(last);
        });
    });
};


/**
 * Destroy connection to remote UFDS.
 */
RemoteDirectory.prototype.destroy = function destroy() {
    if (this.client.destroyed) {
        return;
    }
    this.client.destroy();
};

/**
 * Unbind/disconnect from remote UFDS.
 */
RemoteDirectory.prototype.unbind = function unbind(callback) {
    if (this.client.connected) {
        callback = (callback) ? callback : function () { };
        this.client.unbind(callback);
    }
};


/**
 * Parse queries for entry matching.
 */
RemoteDirectory.prototype._parseQueries = function _parseQueries(queries) {
    var self = this;
    var parsed = [];
    queries.forEach(function (query) {
        var url = ldap.parseURL(
            (self.identity.url + query).replace(/\s/g, '%20'));

        var filter = url.filter || ldap.filters.parseString('(objectclass=*)');
        var scope = url.scope || 'sub';

        // Only support scope=sub for how
        assert.equal(scope, 'sub');
        assert.string(url.DN);

        parsed.push({
            query: query,
            dn: ldap.parseDN(url.DN),
            filter: filter,
            scope: scope
        });
    });
    this.queries = parsed;
};


/**
 * Test changelog entry against configured queries.
 */
RemoteDirectory.prototype._matchQueries = function _matchQueries(entry) {
    var matches = [];
    for (var i = 0; i < this.queries.length; i++) {
        var query = this.queries[i];

        if (entry.targetdn.childOf(query.dn)) {
            switch (entry.changetype) {
            case 'modify':
            case 'delete':
                // The local entry must be consulted for validity
                matches.push(query.filter);
                break;
            case 'add':
                // Add entries are easy. They can be matched on the spot.
                if (query.filter.matches(entry.changes)) {
                    matches.push(query.filter);
                    return matches;
                }
                break;
            default:
                this.emit('error', new Error('invalid change type: %s',
                            entry.changetype));
                break;
            }
        }
    }
    return matches;
};
