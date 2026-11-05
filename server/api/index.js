'use strict';
// Vercel entry point: every request is rewritten here (see vercel.json).
const { open } = require('../src/db');
const { createApp } = require('../src/app');

let app;
module.exports = (req, res) => {
  app ||= createApp(open());
  return app.handle(req, res);
};
