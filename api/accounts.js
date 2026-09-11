const UPSTREAM = 'https://crudcrud.com/api/dcc16c221e224c5b9ccb81ba43d2f5af/accounts';

function send(res, status, body, contentType) {
  res.statusCode = status;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Accept');
  if (contentType) res.setHeader('Content-Type', contentType);
  res.end(body);
}

function readBody(req) {
  return new Promise(function (resolve, reject) {
    if (req.body != null) {
      resolve(typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
      return;
    }
    var chunks = [];
    req.on('data', function (c) { chunks.push(c); });
    req.on('end', function () { resolve(Buffer.concat(chunks).toString('utf8') || '{}'); });
    req.on('error', reject);
  });
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function isGatewayFail(status, text) {
  if (status === 502 || status === 503 || status === 504) return true;
  var t = String(text || '').toLowerCase();
  return /bad gateway|gateway time|nginx/.test(t);
}

async function fetchUpstream(target, opts) {
  var lastStatus = 502;
  var lastText = JSON.stringify({ error: 'Cloud sync failed' });
  var lastType = 'application/json';
  for (var i = 0; i < 3; i++) {
    try {
      var upstream = await fetch(target, opts);
      var text = await upstream.text();
      var type = upstream.headers.get('content-type') || 'application/json';
      if (!isGatewayFail(upstream.status, text)) {
        return { status: upstream.status, text: text, type: type };
      }
      lastStatus = upstream.status;
      lastText = text;
      lastType = type;
    } catch (err) {
      lastStatus = 502;
      lastText = JSON.stringify({ error: 'Cloud sync failed' });
      lastType = 'application/json';
    }
    await sleep(350 * (i + 1));
  }
  return { status: lastStatus, text: lastText, type: lastType };
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    send(res, 204, '');
    return;
  }

  var id = '';
  try {
    var url = new URL(req.url, 'http://localhost');
    id = url.searchParams.get('id') || '';
  } catch (e) {}

  var target = id ? UPSTREAM + '/' + encodeURIComponent(id) : UPSTREAM;
  try {
    var opts = { method: req.method, headers: { Accept: 'application/json' } };
    if (req.method === 'POST' || req.method === 'PUT') {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = await readBody(req);
    }
    var result = await fetchUpstream(target, opts);
    send(res, result.status, result.text, result.type);
  } catch (err) {
    send(res, 502, JSON.stringify({ error: 'Cloud sync failed' }), 'application/json');
  }
};
