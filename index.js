const NODE_ENV = process.env.NODE_ENV;
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = process.env.SMTP_PORT;
const SMTP_USERNAME = process.env.SMTP_USERNAME;
const SMTP_PASSWORD = process.env.SMTP_PASSWORD;
const FROM_EMAIL = process.env.FROM_EMAIL;
const SYNC_BASE_URL = process.env.SYNC_BASE_URL;

if(!NODE_ENV) return console.error(`Env-Var NODE_ENV missing`);
if(!SMTP_HOST) return console.error(`Env-Var SMTP_HOST missing`);
if(!SMTP_PORT) return console.error(`Env-Var SMTP_PORT missing`);
if(!SMTP_USERNAME) return console.error(`Env-Var SMTP_USERNAME missing`);
if(!SMTP_PASSWORD) return console.error(`Env-Var SMTP_PASSWORD missing`);
if(!FROM_EMAIL) return console.error(`Env-Var FROM_EMAIL missing`);
if(!SYNC_BASE_URL) return console.error(`Env-Var SYNC_BASE_URL missing`);
if(!(NODE_ENV && SMTP_HOST && SMTP_PORT && SMTP_USERNAME && SMTP_PASSWORD && FROM_EMAIL && SYNC_BASE_URL)) return exit(1);

console.log(`NODE_ENV: ${NODE_ENV}`);
console.log(`SMTP_HOST: ${SMTP_HOST}`);
console.log(`SMTP_PORT: ${SMTP_PORT}`);
console.log(`SMTP_USERNAME: ${SMTP_USERNAME}`);
console.log(`SMTP_PASSWORD: ${SMTP_PASSWORD}`);
console.log(`FROM_EMAIL: ${FROM_EMAIL}`);
console.log(`SYNC_BASE_URL: ${SYNC_BASE_URL}`);

const {interval} = require('linklet');
const fs = require('fs');
const _ = require('lodash');
const moment = require('moment');
const SMTPConnection = require('nodemailer/lib/smtp-connection');
const MailComposer = require('nodemailer/lib/mail-composer');
const PouchDB = require('pouchdb');

PouchDB.plugin(require('pouchdb-adapter-memory'));
const usersDB = new PouchDB('users', {adapter: 'memory'});
const statisticsDB = new PouchDB('statistics', {adapter: 'memory'});
const deploymentsDB = new PouchDB('deployments', {adapter: 'memory'});

let currentUsers = [];
let currentStats = [];
let currentDeployments = [];

PouchDB.replicate(new PouchDB(`${SYNC_BASE_URL}/users`), usersDB, {live: true, retry: true, batch_size: 1000})
.on('change', changes => usersChangedHandler(changes))
.on('complete', () => console.log(`Sync from ${SYNC_BASE_URL}/users completed`))
.on('error', error => console.error(`Sync from ${SYNC_BASE_URL}/users error`));

PouchDB.replicate(new PouchDB(`${SYNC_BASE_URL}/statistics`), statisticsDB, {live: true, retry: true, batch_size: 1000})
.on('change', changes => statisticsChangedHandler(changes))
.on('complete', () => console.log(`Sync from ${SYNC_BASE_URL}/statistics completed`))
.on('error', error => console.error(`Sync from ${SYNC_BASE_URL}/statistics error`));

PouchDB.replicate(new PouchDB(`${SYNC_BASE_URL}/deployments`), deploymentsDB, {live: true, retry: true, batch_size: 1000})
.on('change', changes => deploymentsChangedHandler(changes))
.on('complete', () => console.log(`Sync from ${SYNC_BASE_URL}/deployments completed`))
.on('error', error => console.error(`Sync from ${SYNC_BASE_URL}/deployments error`));

module.exports = interval({period: 250})(() => {
  const endOfDay = moment().endOf('day').toString();
  const currentDateTime = moment().toString();

  if(currentDateTime === endOfDay) {
    currentStats.forEach(x => {
      x.services = Object.keys(x.services).map(i => x.services[i]).map(y => {
        const currentDeployment = currentDeployments.find(z => z.serviceName === y.name)
        return Object.assign({}, y, currentDeployment)
      });
      console.log(x.services)
      sendUsageEmail({to: x.id, usage: x})
      .then(data => console.log(`Statistic email to ${x.id}. ${data}`))
      .catch(console.error);
    })
  }
});

function deploymentsChangedHandler(changes) {
  deploymentsDB
  .allDocs({include_docs: true})
  .then(data => currentDeployments = data.rows.map(x => Object.assign({}, x.doc, {id: x.doc._id, _id: undefined, _rev: undefined})))
}

function statisticsChangedHandler(changes) {
  statisticsDB
  .allDocs({include_docs: true})
  .then(data => {
    currentStats = data.rows.map(x => Object.assign({}, x.doc, {id: x.doc._id, _id: undefined, _rev: undefined}));
    currentStats = NODE_ENV === 'development'
      ? currentStats.filter(x => x.id === 'go@dropstack.run')
      : currentStats.filter(x => x.id !== 'admin')
  });
}

function usersChangedHandler(changes) {
  usersDB
  .allDocs({include_docs: true})
  .then(data => {
    changedUsers = data.rows.map(x => Object.assign({}, {id:  x.doc._id}, x.doc.metadata));

    if(currentUsers.length === 0) currentUsers = changedUsers;

    // changed users to send welcome email
    const newUsers = _.differenceWith(changedUsers, currentUsers, (a, b) => a.id === b.id);
    newUsers.forEach(x =>
      sendWelcomeEmail({to: x.id})
      .then(data => console.log(`Welcome email to ${x.id}. ${data}`))
      .catch(console.error)
    );

    currentUsers = _.uniqBy(currentUsers.concat(newUsers), x => x.id);

    // changed plan email
    const changedUser = changedUsers[0] || {};
    const currentUser = currentUsers.find(({id, plan}) => id === changedUser.id && plan !== changedUser.plan);
    if(currentUser) {
      currentUser.plan = changedUser.plan;
      sendPlanEmail({to: changedUser.id, plan: changedUser.plan})
      .then(data => console.log(`Plan changed email to ${changedUser.plan} for ${changedUser.id}. ${data}`))
      .catch(console.error);
    }
  })
}

function sendWelcomeEmail ({to}) {
  console.log(`Sending welcome email to ${to}`);
  const html = fs.readFileSync('templates/welcome.tpl.html');
  return sendEMail({
    to,
    subject: `Welcome to Awesomeness!`,
    html,
  });
}

function sendPlanEmail ({to, plan = 'free'}) {
  console.log(`Sending plan email to ${to}`);
  const html = _.template(fs.readFileSync('templates/plan.tpl.html'))({plan: plan.toUpperCase()});
  return sendEMail({
    to,
    subject: `${plan.toUpperCase()} Plan Activated!`,
    html,
  });
}

function sendUsageEmail ({to, usage}) {
  console.log(`Sending usage email to ${to}`);
  const html = _.template(fs.readFileSync('templates/daily-usage.tpl.html'))({usage});
  return sendEMail({
    to,
    subject: `Daily Usage Statistics`,
    html,
  });
}

function sendEMail({to, subject, html}) {
  return new Promise((resolve, reject) => {
    const connection = new SMTPConnection({host: SMTP_HOST, port: SMTP_PORT, secure: true});
    connection.connect(error => {
      if(error) return reject(error);

      connection.login({credentials: {user: SMTP_USERNAME, pass: SMTP_PASSWORD}}, (error, data) => {
        if(error) {
          connection.quit();
          return reject(error);
        }
        const mail =  new MailComposer({from: `DROPSTACK | CLOUD <${FROM_EMAIL}>`, to, subject, html});
        const mailStream = mail.compile().createReadStream();
        connection.send({from: FROM_EMAIL, to}, mailStream, (error, data) => {
          if(error) {
            connection.quit();
            return reject(error);
          }
          connection.quit();
          if(!data.accepted) return reject(new Error('Email sending error'));
          return resolve(`Email sent.`);
        });
      });
    });
  });
}