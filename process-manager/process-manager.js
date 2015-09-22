module.exports = ProcessManager;

var debug = require('debug')('strong-arc:process-manager');
var split = require('split');
var spawn = require('child_process').spawn;
var httpProxy = require('http-proxy');
var fs = require('fs-extra');
var path = require('path');
var util = require('util');

function ProcessManager(root) {
  var pm = this;
  this.root = root;
  this.port = null;
  this.proxy = httpProxy.createProxyServer();
  this.queue = [];
}

ProcessManager.prototype.start = function(cb) {
  var pm = this;
  var args = [
    require.resolve('strong-pm/bin/sl-pm'),
    '--listen=0',
    '--base=.strong-pm',
    '--no-control',
  ];
  var envOverrides = {};

  this.setStatus('starting');

  this.removeDir(function(err) {
    if(err) {
      return cb(err);
    }

    pm.process = spawn(process.execPath, args, {
        stdio: [0, 'pipe', 2, 'ipc'],
        env: util._extend(process.env, envOverrides)
    });

    if (debug.enabled) {
      pm.process.stdout.pipe(process.stdout);
    }

    pm._parseOutputForPort();
    pm._handleExit();
  });

}

ProcessManager.prototype.log = function(msg) {
  debug(msg);
}

ProcessManager.prototype._handleExit = function() {
  var pm = this;
  this.process.once('exit', function(code) {
    pm.log('exited with code' + code);
    pm.exitCode = code;
    if(code) {
      pm.setStatus('crashed');
    } else {
      pm.setStatus('stopped');
    }
    pm.removeDir();
  });
}

ProcessManager.prototype._parseOutputForPort = function() {
  var pm = this;
  this.process.stdout.pipe(split()).on('data', function(line) {
    if(pm.status() === 'starting') {
      pm.port = parsePort(line);
      if(pm.port) {
        pm.setStatus('started');
        pm.log('using port ' + pm.port);
        pm._handleStart();
      }
    }
  });
}

ProcessManager.prototype._handleStart = function() {
  var pm = this;
  this.queue.forEach(function(item) {
    pm.proxyRequest(item.req, item.res);
  });
}

ProcessManager.prototype.proxyRequest = function(req, res) {
  var pm = this;
  switch(this.status()) {
    case 'stopped':
      pm.log('stopped... restarting!');
      this.start(function(err) {
        if(err) {
          pm.log('failed to restart!');
          console.error(err);
        } else {
          fwd();
        }
      });
    break;
    case 'crashed':
      res.status(500).send({error: 'process manager unavailable'});
    break;
    case 'starting':
      this.queueRequest(req, res);
    break;
    case 'started':
      fwd();
    break;
  }

  function fwd() {
    req.url = req.url.replace('/process-manager', '/');
    pm.proxy.web(req, res, {
      target: 'http://localhost:' + pm.port
    }, function(err) {
      res.status(500).send(err);
    });
  }
}

ProcessManager.prototype.queueRequest = function(req, res) {
  var queue = this.queue;

  // ensure the queue only ever contains the request once
  for (var i = queue.length - 1; i >= 0; i--) {
    if(queue[i] && queue[i].req === req) {
      return;
    }
  }

  this.queue.push({req: req, res: res});
}

ProcessManager.prototype.status = function() {
  return this._status;
}

ProcessManager.prototype.setStatus = function(status) {
  this.log(status);
  this._status = status;
}

ProcessManager.prototype.removeDir = function(cb) {
  cb = cb || function noop() {};
  var dir = path.join(this.root, '.strong-pm');
  fs.remove(dir, cb);
}

function parsePort(line) {
  var match = line.match(/: listen on (\d+)/);
  if(match) {
    return match[1];
  }
}
