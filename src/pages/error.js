'use strict';

const params = new URLSearchParams(location.search);
const url = params.get('url') || '';
const code = Number(params.get('code'));
const desc = params.get('desc') || '';
let host = url;
try {
  host = new URL(url).hostname;
} catch {}

const messages = {
  '-105': ['Can’t find this site', `${host}’s address couldn’t be found. Check the spelling or your connection.`],
  '-106': ['You’re offline', 'Check your internet connection and try again.'],
  '-102': ['Connection refused', `${host} refused to connect.`],
  '-118': ['Took too long to respond', `${host} didn’t respond in time.`],
  '-109': ['Can’t reach this page', `${host} is unreachable right now.`],
  '-200': ['Your connection isn’t private', `${host}’s security certificate isn’t valid. Someone could be trying to intercept your connection.`],
  '-201': ['Your connection isn’t private', `${host}’s certificate date is invalid. Check your computer’s clock.`],
  '-202': ['Your connection isn’t private', `${host}’s certificate isn’t trusted.`],
};
const [head, detail] = messages[String(code)] || (String(code).startsWith('-2') ? messages['-200'] : ['This page can’t be reached', `${host} couldn’t be loaded.`]);
document.title = head;
document.getElementById('head').textContent = head;
document.getElementById('detail').textContent = detail;
document.getElementById('code').textContent = `${desc || 'ERROR'} (${code}) · ${url}`;
document.getElementById('retry').addEventListener('click', () => {
  if (/^https?:/.test(url)) location.href = url;
});
