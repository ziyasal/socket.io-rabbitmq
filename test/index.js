/**
 * import(s)
 */

var expect = require('expect.js');
var format = require('util').format;
var http = require('http').Server;
var io = require('socket.io');
var ioc = require('socket.io-client');
var async = require('async');
var amqp = require('amqplib');
var Adapter = require('../');


function client(port, ns, opts) {
    if (typeof ns === 'object') {
        opts = ns;
        ns = null;
    }

    var url = format('http://localhost:%s%s', port, (ns || ''));
    return ioc(url, opts);
}
var rabbitConn;


function _connect(url, cb) {

    amqp.connect(url)
        .then(function (conn) {
            rabbitConn = conn;

            // Create the rabbit channel
            return rabbitConn.createChannel();
        }).then(function (ch) {
            return cb(null, ch);
        }).catch(function (err) {
            console.error("[AMQP] create channel error", err.message);
            return cb(err);
        });
}


/**
 * test(s)
 */

describe('socket.io-rabbitmq', function () {
    if (!Array.prototype.remove) {
        Array.prototype.remove = function (value) {
            this.splice(this.indexOf(value), 1);
            return true;
        };
    }
    describe('broadcast', function () {

        var url = process.env.RABBITMQ_URL ? process.env.RABBITMQ_URL : "amqp://192.168.59.103:5672";

        var publisher;
        var subscriber;

        beforeEach(function (done) {
            var self = this;
            var PORT_ARRAY = [1, 2, 3, 4, 5, 6, 7, 8, 9];

            async.times(1, function (n, next) {
                var pub, sub;


                async.parallel([
                        function (callback) {
                            _connect(url, function cb(err, ch) {
                                if (err) return callback(err);

                                pub = publisher = ch;
                                callback(null);
                            });
                        },
                        function (callback) {
                            _connect(url, function cb(err, ch) {
                                if (err) return callback(err);

                                sub = subscriber = ch;
                                callback(null);
                            });
                        }
                    ],
                    function (err, results) {

                        var srv = http();
                        var sio = io(srv, {
                            adapter: Adapter({
                                pubClient: pub,
                                subClient: sub,
                                url: url
                            })
                        });

                        var PORT = PORT_ARRAY[Math.floor(Math.random() * PORT_ARRAY.length)];
                        PORT_ARRAY.remove(PORT);
                        srv.listen(PORT, function () {
                            ['/', '/nsp'].forEach(function (name) {
                                sio.of(name).on('connection', function (socket) {
                                    socket.on('join', function (fn) {
                                        socket.join('room', fn);
                                    });

                                    socket.on('socket broadcast', function (data) {
                                        socket.broadcast.to('room').emit('broadcast', data);
                                    });

                                    socket.on('namespace broadcast', function (data) {
                                        sio.of('/nsp').in('room').emit('broadcast', data);
                                    });
                                });
                            });

                            async.parallel([
                                function (fn) {
                                    async.times(1, function (n, next) {
                                        var socket = client(PORT, '/nsp', {forceNew: true});
                                        socket.on('connect', function () {
                                            socket.emit('join', function () {
                                                next(null, socket);
                                            });
                                        });
                                    }, fn);
                                },
                                function (fn) {
                                    var socket = client(PORT, '/nsp', {forceNew: true});
                                    socket.on('connect', function () {
                                        socket.on('broadcast', function () {
                                            throw new Error('Called unexpectedly: different room');
                                        });
                                        fn();
                                    });
                                },
                                function (fn) {
                                    var socket = client(PORT, {forceNew: true});
                                    socket.on('connect', function () {
                                        socket.on('broadcast', function () {
                                            throw new Error('Called unexpectedly: different room');
                                        });
                                    });
                                    socket.emit('join', function () {
                                        fn();
                                    });
                                }
                            ], function (err, results) {
                                next(err, results[0]);
                            });
                        });
                    });


            }, function (err, sockets) {
                self.sockets = sockets.reduce(function (a, b) {
                    return a.concat(b);
                });
                done(err);
            });
        });

        afterEach(function (done) {
            publisher.close();
            subscriber.close();
            done();
        });


        it('should broadcast from a socket', function (done) {
            async.each(this.sockets.slice(1), function (socket, next) {
                socket.on('broadcast', function (msg) {
                    expect(msg).to.equal('hi');
                    next();
                });
            }, done);

            var socket = this.sockets[0];
            socket.on('broadcast', function () {
                throw new Error('Called unexpectedly: some socket');
            });

            // emit !!
            setTimeout(function () {
                socket.emit('socket broadcast', 'hi');
            }, 50);
        });

        it('should broadcast from a namespace', function (done) {
            async.each(this.sockets, function (socket, next) {
                socket.on('broadcast', function (msg) {
                    expect(msg).to.equal('hi');
                    next();
                });
            }, done);

            // emit !!
            var socket = this.sockets[0];
            setTimeout(function () {
                socket.emit('namespace broadcast', 'hi');
            }, 50);
        });
    });
});
