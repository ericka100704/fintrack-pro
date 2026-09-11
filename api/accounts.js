const UPSTREAM = 'https://crudcrud.com/api/fa23d18258b84dcebc568c2bb99c7c01/accounts';

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
    var upstream = await fetch(target, opts);
    var text = await upstream.text();
    send(res, upstream.status, text, upstream.headers.get('content-type') || 'application/json');
  } catch (err) {
    send(res, 502, JSON.stringify({ error: 'Cloud sync failed' }), 'application/json');
  }
};
