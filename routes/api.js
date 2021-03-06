var express = require('express');
var url = require("url");
var router = express.Router();
const orm = require('../bin/orm');
const fs = require('fs');
const useragent = require('useragent')
let cors = require('cors')
const config = require('../bin/config');
const corsOptions = { origin: config.api.cors.origin }

var spec = {
  paths: {
    "sde": JSON.parse(fs.readFileSync('../tools/db2api/evesde.json')),
    "esi": JSON.parse(fs.readFileSync('../tools/db2api/esi.json')),
  },
  root: JSON.parse(fs.readFileSync('../tools/db2api/api.json'))
}

router.get('/', function(req, res, next) {
  res.setHeader("Content-Type", "application/json");
  res.send(spec)
});

router.get('/*', cors(corsOptions), function(req, res, next) {
  process(req, res)
});
router.post('/*', cors(corsOptions), function(req, res, next) {
  process(req, res)
});
router.patch('/*', cors(corsOptions), function(req, res, next) {
  process(req, res)
});
router.delete('/*', cors(corsOptions), function(req, res, next) {
  process(req, res)
});

router.options('/*', cors(corsOptions))

const opFilters = {C: beforeCreate, R: beforeRead, U: beforeUpdate, D: beforeDelete }

function process(req, res) {
  res.setHeader("Content-Type", "application/json");
  var u = url.parse(req.url)
  var query = {
    filters: []
  }
  var paths = u.pathname.replace(/^\/|\/$/, '').split('/')
  var i = 0
  var apis = null
  while (i < paths.length) {
    var apipath = paths[i]
    // finding mount point
    if (i == 0) {
      apis = spec.paths[apipath]
      if (apis) {
        ++i;
        continue; // apis path matched, move next level
      }
      apis = spec.root // apis path did not match, assume root and continue with the current level
    }
    var api = apis.paths[apipath]
    if (!api) {
      res.status(404).send('Not Found')
      return
    }
    // Check Auth token right away
    if (api.protected) {
      const auth_token = req.headers['x-hr-authtoken'] || req.query.auth_token
      query.auth = {
         token: auth_token,
         device: get_device(req.headers['user-agent'])
      }
      if (!query.auth.device || !query.auth.token) {
        res.status(401).send()
        return
      }
      res.setHeader("Cache-Control", "no-store")
    }
    // is there a path param
    if (paths.length > i + 1) {
      var id = paths[++i]
      if (hasField(api, 'id')) {
        query.filters.push({field: 'id', op: 'eq', val: id})
      }
    }
    ++i // next level
    // this was the last level so query against this api
    if (paths.length === i) {
      query.api = api
      // validate operation
      query.operation = getOperation(req)
      if (!api.operations.includes(query.operation)) {
        res.status(404).send('Not Found')
        return
      }
    }
  }

  if (!query.api) {
    res.status(404).send('Not Found')
    return
  }

  if (req.headers['content-type'] && req.headers['content-type'].includes('application/json')) {
    query.payload = req.body
  }

  // Method specific filters and validation
  const err = opFilters[query.operation](req, query)
  if (err) {
    res.status(400).send(err)
    return
  }

  // TODO: Pagination
  // TODO: Authentication
  // TODO: some common security defenses (SQLI, XSS, CLICKJACK, CSRF, WTF)
  orm.execute(query, function (errors, data) {
    if (errors) {
      res.status(400).send(errors)
    }
    else {
      res.status(200).send(data)
    }
  })
}

function beforeCreate(req, q) {
  if (!q.payload) {
    return 'json payload is required'
  }
  const data = q.payload
  const fields = q.api.fields
  const field = Object.keys(fields)
    .filter(f => fields[f].is_required && !(['id'].includes(f)))
    .find(f => !data[fields[f].name])
  if (field) {
    return `${field} is a required param`
  }
}

function beforeRead(req, q) {
  // Query Filters
  for (let param in req.query) {
    if (req.query.hasOwnProperty(param) && q.api.fields[param]) {
      var filter = {field: q.api.fields[param].name}
      var val = req.query[param]
      var i = val.indexOf('=')
      if (i > -1) {
        filter.op = val.substr(0, i)
        filter.val = val.substr(i+1)
      }
      else {
        filter.op = 'eq'
        filter.val = val
      }
      q.filters.push(filter);
    }
  }
}

function beforeUpdate(req, q) {
  if (!q.filters.find(f => f.field === 'id' && f.val)) {
    return 'id is a required parameter'
  }
  if (!q.payload) {
    return 'no data to update'
  }
}

function beforeDelete(req, q) {

}

function hasField(api, field) {
  return Object.keys(api.fields).find(f => f === field) !== undefined
}

function getOperation(req) {
  switch (req.method) {
    case 'POST': return 'C';
    case 'GET': return 'R';
    case 'PATCH': return 'U';
    case 'DELETE': return 'D';
    default: throw 'Request method ' + req.method + ' has no mapping to api operation'
  }
}

function get_device(user_agent) {
  let ua =  useragent.parse(user_agent);
  return `${ua.family}-${ua.os.family}${ua.os.major}-${ua.device.family}`.toLowerCase()
}

module.exports = router;
