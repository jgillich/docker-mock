var _ = require('lodash');
var tar = require('tar');
var zlib = require('zlib');
var join = require('path').join;
var utils = require('./utils');
var series = require('middleware-flow').series;
var testFile = './test.txt';
var fs = require('fs');
var pid = 0;
function newPid () { return pid++; }
var port = 0;
function newPort () { return port++; }

module.exports = {
  combine: function (req, res, next) {
    if (!req.data) req.data = {};
    if (req.params.registry && req.params.namespace && req.params.repository) {
      req.data.repository = join(req.params.registry, req.params.namespace, req.params.repository);
    } else if (req.params.namespace && req.params.repository) {
      req.data.repository = join(req.params.namespace, req.params.repository);
    } else {
      req.data.repository = req.params.repository;
    }
    next();
  },
  findImage: function (images, tags) {
    return function (req, res, next) {
      var repoSplit = req.params.repository.split(':');
      var repo = repoSplit[0];
      var tag = repoSplit[1] || 'latest';
      repo = repo +':'+ tag;
      var name = [req.params.registry, req.params.namespace, repo].filter(exists).join('/');
      var imageId = tags[name];
      if (!imageId) return res.send(404);
      if (imageId && !images[imageId]) return res.send(500);
      req.data.image = images[imageId];
      req.data.image.RepoTags = [name];
      next();
    };
  },
  buildImage: function (images, tags) {
    return function (req, res, next) {
      var foundDockerFile = false;
      // TODO query.t is required
      var repoSplit = req.query.t.split(':');
      var repo = repoSplit[0];
      var tag = repoSplit[1] || 'latest';
      repo = repo +':'+ tag;
      var name = [req.params.registry, req.params.namespace, repo].filter(exists).join('/');
      var intentionalFail = req.query.fail || false;
      // for a little extra flexability, we'll support gzip
      if (req.headers['content-type'] === 'application/x-gzip') {
        req = req.pipe(zlib.createGunzip());
      }
      req.pipe(tar.Parse()).
        on('entry', function (entry) {
          if (entry.props.path === './Dockerfile') foundDockerFile = true;
          if (entry.props.path === 'Dockerfile') foundDockerFile = true;
        }).
        on('end', function () {
          if (intentionalFail) return resError(500, 'Intentional failure.');
          else if (!foundDockerFile) return resError(500, 'A Dockerfile is required');
          var id = utils.randomId();
          images[id] = {
            'id': id
          };
          tags[name] = id;
          res.json(200, { 'stream': 'Successfully built ' + id });
        });

        function resError (code, message) {
          res.json(code, {
            error: 'Server Error - ' + message,
            errorDetail: {
              code: code,
              message: message
            }
          });
        }
    };
  },
  findContainer: function (containers) {
    return function (req, res, next) {
      if (!req.data) req.data = {};
      var containerId = req.query.container || req.params.id;
      if (!containerId) return res.send(404);
      req.data.container = _.find(containers, function (container, id) {
        return id.indexOf(containerId) === 0;
      });
      if (!req.data.container) return res.send(404);
      next();
    };
  },
  attachContainer: function (req, res, next) {
    setTimeout(function () {
      res.send(200);
    }, 50);
  },
  createContainer: function (containers) {
    return function (req, res, next) {
      var Id = utils.randomId();
      var data = {
        'Id': Id,
        'Hostname': '',
        'User': '',
        'Memory': 0,
        'MemorySwap': 0,
        'AttachStdin': false,
        'AttachStdout': true,
        'AttachStderr': true,
        'PortSpecs': null,
        'Tty': false,
        'OpenStdin': false,
        'StdinOnce': false,
        'Env': null,
        'Cmd': [],
        'Dns': null,
        'Image': null,
        'Volumes': {},
        'VolumesFrom': '',
        'WorkingDir': '',
        'ExposedPorts': {},
        'State': {
          Running: false,
          Pid: -1
        },
        'NetworkSettings': {
          Bridge: "",
          Gateway: "",
          IPAddress: "",
          IPPrefixLen: 0,
          MacAddress: "",
          Ports: null
        }
      };
      data = _.extend(data, req.body);
      var returnData = {
        'Id': Id,
        'Warnings': []
      };
      containers[Id] = data;
      req.data = { container: containers[Id] };
      next();
    };
  },
  createImage: function (images, tags) {
    return function (req, res, next) {
      var id = utils.randomId();
      var from = req.query.fromImage;
      if(!from) {
        res.header("Content-Type", "application/json");
        res.end('{"status":"Downloading from http://"}\n{"errorDetail":{"message":"Get http://: http: no Host in request URL"},"error":"Get http://: http: no Host in request URL"}');
        return;
      }
      images[id] = { id: id };
      tags[from + ":" + (req.query.tag || "latest")] = id;
      res.header("Content-Type", "application/json");
      res.end([
        '{"status":"Pulling repository ' + from + '"}\n',
        '{"status":"Download complete","progressDetail":{},"id":"' + id + '"}',
        '{"status":"Status: Image is up to date for ' + from + '"}'
      ].join(''));
    };
  },
  commitContainer: function (images, tags) {
    return function (req, res, next) {
      if (!req.data.container) return res.send(500);
      var container = req.data.container;
      var repo = req.query.repo;
      var tag = req.query.tag;
      var m = req.query.m;
      var author = req.query.author;
      var run = req.query.run;
      var imageId = utils.randomId();

      tag = tag || 'latest';
      var name = [repo, tag].filter(exists).join(':');
      tags[name] = imageId;

      images[imageId] = {
        id: imageId,
        container: container.Id,
        RepoTags: [name]
      };

      req.data = { image: { 'Id': imageId } };
      next();
    };
  },
  startContainer: function (containers) {
    return function (req, res, next) {
      if (!req.data.container) return res.send(500);
      if (req.data.container.State.Running) {
        return res.send(304, {message: 'Container already running'});
      }
      var Id = req.data.container.Id;
      var container = containers[Id];

      container.State = {
        // TODO: more data!
        Running: true,
        Pid: newPid()
      };
      container.NetworkSettings = {
        Bridge: 'docker0',
        Gateway: '172.17.42.1',
        IPAddress: '172.17.0.'+newPort(),
        IPPrefixLen: 16,
        MacAddress: '02:42:ac:11:00:05',
        Ports: {
          '80/tcp':[{ HostPort: newPort() }],
          '15000/tcp':[{ HostPort: newPort() }]
        }
      };
      req.data.container.State = container.State;
      req.data.container.NetworkSettings = container.NetworkSettings;
      next();
    };
  },
  stopContainer: function (containers) {
    return function (req, res, next) {
      if (!req.data.container) return res.send(500);
      var Id = req.data.container.Id;
      var container = containers[Id];
      if (container.State.Running === false) {
        return res.send(304, {message: 'Container already stopped'});
      }
      container.State = {
        // TODO: more data!
        Running: false,
        Pid: 0
      };
      container.NetworkSettings = {
        Bridge: "",
        Gateway: "",
        IPAddress: "",
        IPPrefixLen: 0,
        MacAddress: "",
        Ports: null
      };
      req.data.container.State = container.State;
      next();
    };
  },
  stopAndWaitContainer: function (containers) {
    return series(
      this.stopContainer(containers),
      function (req, res, next) {
        if (!req.data.container) return res.send(500);
        setTimeout(function () {
          res.json(200, { 'StatusCode': 0 });
        }, 25);
      }
    );
  },
  deleteContainer: function (containers) {
    return function (req, res, next) {
      if (!req.data.container) return res.send(500);
      var Id = req.data.container.Id;
      delete containers[Id];
      next();
    };
  },
  deleteImage: function (images, tags) {
    return function (req, res, next) {
      delete images[req.data.image.id];
      for (var i in req.data.image.RepoTags) {
        delete tags[req.data.image.RepoTags[i]];
      }
      res.send(200);
    };
  },
  respondImage: function (code, pick) {
    return function (req, res, next) {
      if (!req.data || !req.data.image) return res.send(500);
      if (pick) req.data.image = _.pick(req.data.image, pick);
      res.json(code || 200, req.data.image);
    };
  },
  respondImages: function (images, tags) {
    return function (req, res, next) {
      var data = _.map(images, function (image, id) {
        return {
          'Id': id,
          'RepoTags': _.transform(tags, function (acc, imageId, tag) {
            if (imageId === id) acc.push(tag);
          }, [])
        };
      });
      res.json(200, data);
    };
  },
  respondContainer: function (code, pick) {
    return function (req, res, next) {
      if (!req.data || !req.data.container) return res.send(500);
      if (pick) req.data.container = _.pick(req.data.container, pick);
      if (code && code === 204) res.send(204);
      else res.send(code || 200, req.data.container);
    };
  },
  respondContainers: function (containers) {
    return function (req, res, next) {
      res.json(200, _.map(containers, function (container, Id) {
        return {
          'Id': container.Id,
          'Image': container.Image
          // TODO: extend with other data we may want
        };
      }));
    };
  },
  respondLogStream: function () {
    return function (req, res, next) {
      fs.writeFileSync(testFile, 'Just a bunch of text');
      var stream = fs.createReadStream(testFile);
      stream.pipe(res);
      fs.unlinkSync(testFile);
    };
  },
  getInfo: function (containers, images) {
    return function (req, res, next) {
      res.json({
        'Containers': _.size(containers),
        'Images': _.size(images),
        'Mock': true
        // TODO: any other information we need?
      });
    };
  },
  getVersion: function (req, res, next) {
    res.json({
      'Arch': 'amd64',
      'GitCommit': 3600720,
      'GoVersion': 'go1.2.1',
      'KernelVersion': '3.13.3-tinycore64', 'Os':'linux', 'Version':'0.9.1'
    });
  },
  pushRepo: function (tags) {
    return function (req, res, next) {
      var repoSplit = req.params.repository.split(':');
      var repo = repoSplit[0];
      var tag = repoSplit[1] || 'latest';
      repo = repo +':'+ tag;
      var name = [req.params.registry, req.params.namespace, repo].filter(exists).join('/');
      var imageId = tags[name];
      if (!imageId) {
        res.set('Connection', 'close');
        res.send(404);
      }
      else {
        res.json(200, { 'stream': 'Successfully pushed' });
      }
    };
  },
  notYetImplemented: function (req, res, next) {
    res.send(501, 'endpoint not yet implemented: ' + req.method + ' ' + req.path);
  }
};

function exists (v) {
  return v !== undefined && v !== null;
}
