'use strict';

var http = require('http');
var fs = require('fs');
var path = require('path');
var child = require('child_process');

var root = path.join(__dirname, '..');
var port = Number(process.env.PORT) || 8732;
var types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
};

function openBrowser(url) {
  var opened = child.spawn('cmd', ['/c', 'start', '', url], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  opened.unref();
}

function insideRoot(file) {
  var rel = path.relative(root, file);
  return rel === '' || (rel.indexOf('..') !== 0 && !path.isAbsolute(rel));
}

var server = http.createServer(function (req, res) {
  var urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (req.method === 'PUT' && urlPath === '/data/saved-rules.json') {
    var chunks = [];
    var size = 0;
    req.on('data', function (chunk) {
      size += chunk.length;
      if (size > 1024 * 1024) {
        res.writeHead(413);
        res.end('too large');
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', function () {
      var text;
      try {
        text = Buffer.concat(chunks).toString('utf8');
        var parsed = JSON.parse(text);
        if (!Array.isArray(parsed)) throw new Error('not a list');
      } catch (err) {
        res.writeHead(400);
        res.end('bad json');
        return;
      }
      fs.writeFile(path.join(root, 'data', 'saved-rules.json'), JSON.stringify(JSON.parse(text), null, 2) + '\n', function (err) {
        if (err) {
          res.writeHead(500);
          res.end('write failed');
          return;
        }
        res.writeHead(204);
        res.end();
      });
    });
    return;
  }
  if (urlPath === '/') urlPath = '/index.html';
  var file = path.normalize(path.join(root, urlPath));
  if (!insideRoot(file)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  fs.readFile(file, function (err, data) {
    if (err) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': types[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
});

server.on('error', function (err) {
  if (err.code === 'EADDRINUSE') {
    var url = 'http://127.0.0.1:' + port + '/';
    console.log('端口 ' + port + ' 已在使用，打开 ' + url);
    openBrowser(url);
    process.exit(0);
  }
  throw err;
});

server.listen(port, '127.0.0.1', function () {
  var url = 'http://127.0.0.1:' + port + '/';
  console.log(url);
  if (process.env.CAM_OPEN !== '0') openBrowser(url);
});
