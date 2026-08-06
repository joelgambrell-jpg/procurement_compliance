'use strict';

const existing = require('./index');
const production = require('./production');

Object.assign(exports, existing, production);
