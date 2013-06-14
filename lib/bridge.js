/**
 * Encapsulates sdb and other commands which make the bridge
 * between the host and the Tizen target bridge.
 */
var construct = function () {
  'use strict';

  var _ = require('lodash');
  var async = require('async');
  var path = require('path');

  /**
   * config.sdbWrapper: SdbWrapper instance
   * config.logger: object with write(), error(), warn() and ok() methods
   * config.fileLister: FileLister instance
   * config.browserWrapper: (optional) BrowserWrapper instance
   */
  var Bridge = function (config) {
    config = config || {};

    if (!config.logger) {
      throw 'Bridge must be initialised with a logger instance';
    }

    if (!config.sdbWrapper) {
      throw 'Bridge must be initialised with an sdbWrapper instance';
    }

    if (!config.fileLister) {
      throw 'Bridge must be initialised with a fileLister instance';
    }

    // config.browserWrapper is optional

    _.extend(this, config);
  };

  /**
   * Test whether a file exists on the device
   *
   * {String} remoteFilePath Path to test
   * {Function} cb Invoked with cb(null, true) if file exists,
   * cb(null, false) if it doesn't exist, or cb(error) if an error
   * occurred
   */
  Bridge.prototype.fileExists = function (remotePath, cb) {
    var logger = this.logger;
    var cmd = 'stat ' + remotePath;

    this.sdbWrapper.shell(cmd, function (err, stdout, stderr) {
      if (err) {
        logger.error(stderr);
        cb(err);
      }
      else {
        var fileExists = !(/No such file or directory/.test(stdout));
        cb(null, fileExists);
      }
    });
  };

  /**
   * Build a remote path composed of the basename of localFilePath
   * appended to remoteDir
   */
  Bridge.prototype.getDestination = function (localFile, remoteDir) {
    var basename = path.basename(localFile);
    return path.join(remoteDir, basename);
  };

  /**
   * Apply chmod to a remote path
   */
  Bridge.prototype.chmod = function (remotePath, chmod, cb) {
    var logger = this.logger;

    var cmd = 'chmod ' + chmod + ' ' + remotePath;

    this.sdbWrapper.shell(cmd, function (err, stdout, stderr) {
      if (err) {
        logger.error(stderr);
        logger.warn('could not chmod ' + remotePath);
      }
      else {
        logger.write(stdout);
        logger.ok('did chmod ' + chmod + ' on ' + remotePath);
      }

      cb();
    });
  };

  /**
   * Get list of remote files.
   *
   * {String|Object|String[]} remoteFiles Files to install on the device;
   * if an Object, it should look like:
   *
   *   {pattern: '/home/developer/*.wgt', filter: 'latest'}
   *
   * The pattern and filter (optional) properties specify how to find the
   * files on the device; pattern is a file glob usable with ls and
   * filter can take the value 'latest', meaning install only the latest
   * matching file.
   * {Function} cb Callback; invoked with cb(error) or
   * cb(null, <filename array>)
   */
  Bridge.prototype.listRemoteFiles = function (remoteFiles, cb) {
    var logger = this.logger;

    if (_.isString(remoteFiles)) {
      cb(null, [remoteFiles]);
    }
    else if (_.isObject(remoteFiles)) {
      // ls -1 -c returns newest file at the top of a list of filenames
      // separated by newlines
      var cmd = 'ls -1 -c ' + remoteFiles.pattern;

      // callback for when we've executed ls: filter files according
      // to remoteFiles.filter
      var resultCb = function (fileArray) {
        if (remoteFiles.filter === 'latest') {
          cb(null, [fileArray[0]]);
        }
        else {
          cb(null, fileArray);
        }
      };

      this.sdbWrapper.shell(cmd, function (err, stdout, stderr) {
        if (err) {
          logger.error('could not run ls on device');
          logger.error(err);
          logger.error(stderr);
          cb(err);
        }
        else {
          // this cleans up stdout so it contains no blank lines
          // and can be easily split
          stdout = stdout.replace(/\r/g, '');
          stdout = stdout.replace(/^\n$/g, '');
          resultCb(stdout.split('\n'));
        }
      });
    }
    // assume remoteFiles is an array
    else {
      cb(null, remoteFiles);
    }
  };

  /**
   * Raw sdb push.
   *
   * {String} localFile Path to local file to push
   * {String} remotePath Full destination path for file
   * {Function} cb Callback; invoked with cb(error) or cb()
   */
  Bridge.prototype.pushRaw = function (localFile, remotePath, cb) {
    var logger = this.logger;

    this.sdbWrapper.push(localFile, remotePath, function (err, stdout, stderr) {
      if (err ||
          stderr.match('failed to copy') ||
          stderr.match('cannot stat')) {
        logger.error(stderr);
        cb(new Error('could not push file to device'));
      }
      else {
        logger.ok('pushed local:' + localFile + ' to remote:' + remotePath);
        cb();
      }
    });
  };

  /**
   * Push one file with overwrite protection and chmod after push is successful.
   */
  Bridge.prototype.pushOne = function (localFile, remoteDir, overwrite, chmod, cb) {
    var bridge = this;
    var logger = this.logger;
    var remotePath = bridge.getDestination(localFile, remoteDir);

    var cbWrapped = cb;

    if (chmod) {
      // modify the callback to run chmod on the file after pushing it
      cbWrapped = function () {
        bridge.chmod(remotePath, chmod, cb);
      };
    }

    if (overwrite) {
      bridge.pushRaw(localFile, remotePath, cbWrapped);
    }
    else {
      bridge.fileExists(remotePath, function (err, result) {
        if (err) {
          cb(err);
        }
        else if (result) {
          logger.warn('not pushing to ' + remotePath + ' as file exists ' +
                      'and overwrite is false');
        }
        else {
          bridge.pushRaw(localFile, remotePath, cbWrapped);
        }
      });
    }
  };

  /**
   * Push multiple files in parallel.
   */
  Bridge.prototype.push = function (localFiles, remoteDir, overwrite, chmod, cb) {
    var bridge = this;
    var logger = this.logger;

    this.fileLister.list(localFiles, function (err, filesToPush) {
      if (err) {
        cb(err);
      }
      else {
        async.each(
          filesToPush,

          function (localFile, asyncCb) {
            bridge.pushOne(localFile, remoteDir, overwrite, chmod, asyncCb);
          },

          function (err) {
            if (err) {
              logger.error(err);
              cb(new Error('error while pushing files'));
            }
            else {
              logger.ok('all files pushed');
            }

            cb();
          }
        );
      }
    });
  };

  /**
   * Run a script on the device.
   *
   * {String} remoteScript Absolute path to the remote script to run
   * {String[]} args Array of arguments to pass to the script
   * {Function} cb Callback; invoked with cb(error) or cb(null)
   */
  Bridge.prototype.runScript = function (remoteScript, args, cb) {
    var logger = this.logger;

    // make the actual command which will run inside the shell
    var cmd = remoteScript + ' ' + args.join(' ');

    this.sdbWrapper.shell(cmd, function (err, stdout, stderr) {
      if (err) {
        logger.error(stderr);
        cb(new Error('error occurred while running script ' + remoteScript));
      }
      else {
        logger.write(stdout);
        cb();
      }
    });
  };

  /**
   * Install a single package on the device via tizen-app.sh, which
   * wraps pkgcmd.
   *
   * {String} remoteScript Path to the remote tizen-app.sh script
   * {String|Object|String[]} remoteFile Remote wgt file already on the
   * device, which is to be installed
   * {Function} cb Callback which receives either cb(error) or cb(null, result)
   */
  Bridge.prototype.installOne = function (remoteScript, remoteFile, cb) {
    var logger = this.logger;
    var cmd = remoteScript + ' install ' + remoteFile;

    this.sdbWrapper.shell(cmd, function (err, stdout, stderr) {
      logger.write(stdout);

      if (err || stdout.match(/key\[end\] val\[fail\]/)) {
        logger.error('error installing package ' + remoteFile);
        logger.error(stderr);
        cb(new Error('installation failed'));
      }
      else {
        logger.ok('installed package ' + remoteFile);
        cb();
      }
    });
  };

  /**
   * Install one or more packages on the device.
   *
   * {String} remoteScript Path to the remote tizen-app.sh script
   * {String|Object|String[]} remoteFiles Remote files already on the
   * device, which are to be installed. See listRemoteFiles for
   * the structure.
   * {Function} cb Callback which receives either cb(error) or cb(null, result)
   */
  Bridge.prototype.install = function (remoteScript, remoteFiles, cb) {
    var self = this;
    var logger = this.logger;

    var installFiles = function (filesToInstall) {
      async.each(
        filesToInstall,

        function (fileToInstall, asyncCb) {
          self.installOne(remoteScript, fileToInstall, asyncCb);
        },

        function (err) {
          if (err) {
            logger.error(err);
            cb(new Error('error while installing package'));
          }
          else if (!filesToInstall.length) {
            logger.warn('no packages to install');
          }
          else {
            logger.ok('all packages installed');
          }

          cb();
        }
      );
    };

    // which files to install
    this.listRemoteFiles(remoteFiles, function (err, files) {
      if (err) {
        cb(err);
      }
      else {
        installFiles(files);
      }
    });
  };

  /**
   * Uninstall a Tizen app by ID (i.e. the ID in the <widget> element).
   *
   * {String} remoteScript Path to tizen-app.sh script on device.
   * {String} appId Application ID
   * {Boolean} stopOnFailure If true and the uninstallation fails, cb(error)
   * {Function} cb Callback invoked with cb(error) on error, or cb() if
   * uninstall was OK
   */
  Bridge.prototype.uninstall = function (remoteScript, appId, stopOnFailure, cb) {
    var logger = this.logger;

    var cmd = remoteScript + ' uninstall ' + appId;

    logger.ok('running: ' + cmd);

    this.sdbWrapper.shell(cmd, function (err, stdout, stderr) {
      logger.write(stdout);

      if (err || stdout.match('not installed|failed')) {
        if (stopOnFailure) {
          logger.error(stderr);
          cb(new Error('package with id ' + appId + ' could not be uninstalled'));
        }
        else {
          logger.warn('could not uninstall package; continuing anyway');
          cb();
        }
      }
      else {
        logger.ok('package with id ' + appId + ' uninstalled');
        cb();
      }
    });
  };

  /**
   * Start/stop/debug an application; wraps wrt-launcher, so it needs
   * the app's URI rather than its ID.
   */
  Bridge.prototype.launch = function (remoteScript, subcommand, appUri,
  stopOnFailure, cb) {
    var logger = this.logger;
    var actionDone = (subcommand === 'stop' ? 'stopped' : 'launched');

    var cmd = remoteScript + ' ' + subcommand + ' ' + appUri;

    logger.ok('running: ' + cmd);

    this.sdbWrapper.shell(cmd, function (err, stdout, stderr) {
      if (err || stdout.match('running|does not exist|failed')) {
        var warning = 'app with id ' + appUri + ' could not be ' + actionDone;

        if (stopOnFailure) {
          logger.error(stdout);
          logger.error(stderr);
          logger.error('could not ' + subcommand + ' app with ID ' + appUri);
          cb(new Error(warning));
        }
        else {
          logger.warn(warning + '; continuing anyway');
          cb();
        }
      }
      else {
        logger.write(stdout);
        logger.ok('app with id ' + appUri + ' ' + actionDone);
        cb(null, stdout);
      }
    });
  };

  /**
   * Construct the debug URL for an app on TCP port localPort.
   */
  Bridge.prototype.getDebugUrl = function (localPort) {
    return 'http://localhost:' + localPort + '/inspector.html?page=1';
  };

  /**
   * Run a browser command to open the debug inspector.
   */
  Bridge.prototype.runBrowser = function (browserCmd, localPort, cb) {
    var logger = this.logger;
    var url = this.getDebugUrl(localPort);

    if (this.browserWrapper) {
      browserCmd = browserCmd.replace('%URL%', url);

      this.browserWrapper(browserCmd, function (err, stdout, stderr) {
        if (err) {
          logger.error(stderr);
          cb(err);
        }
        else {
          logger.write(stdout);
          cb();
        }
      });
    }
    else {
      var msg = 'cannot run browser: no browserWrapper configured for Bridge';
      cb(new Error(msg));
    }
  };

  /**
   * Use sdb to forward a local port to a remote debugging port on the
   * device.
   */
  Bridge.prototype.portForward = function (localPort, remotePort, cb) {
    var self = this;
    var logger = this.logger;

    this.sdbWrapper.forward(localPort, remotePort, function (err, stdout, stderr) {
      if (err) {
        logger.error(stderr);
        logger.error('could not forward local port to remote port');
        cb(err);
      }
      else {
        var url = self.getDebugUrl(localPort);
        logger.ok('app is ready for debugging at \n' + url);

        cb();
      }
    });
  };

  /**
   * Call "sdb root on" to make future sdb commands run as root
   * on the device.
   * {Boolean} on Set to true to set root on, false to set root off
   */
  Bridge.prototype.root = function (on, cb) {
    var logger = this.logger;
    var state = (on ? 'on' : 'off');

    this.sdbWrapper.root(on, function (err, stdout, stderr) {
      logger.write(stdout);

      if (err) {
        logger.error(stderr);
        cb(err);
      }
      else {
        if (on) {
          logger.warn('*** called "sdb root ' + state + '"; ' +
                      'commands now running as root ***');
        }
        else {
          logger.ok('*** called "sdb root ' + state + '"; ' +
                    'commands no longer running as root ***');
        }
        cb();
      }
    });
  };

  /**
   * Call "sdb root off" to make sdb commands run as non-root
   * user on the device
   */
  Bridge.prototype.rootOn = function (cb) {
    this.root(true, cb);
  };

  /**
   * Call "sdb root off" to make sdb commands run as non-root
   * user on the device
   */
  Bridge.prototype.rootOff = function (cb) {
    this.root(false, cb);
  };

  return Bridge;
};

var Bridge = construct();

module.exports = {
  init: function (config) {
    'use strict';

    return new Bridge(config);
  }
};