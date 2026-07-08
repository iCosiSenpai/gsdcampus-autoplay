/**
 * platform.js — costanti della piattaforma GSD Campus condivise tra autoplay e
 * healthcheck.
 *
 * Centralizzate qui per evitare divergenze di fingerprint tra l'autoplay e la
 * sonda (se usassero user-agent o dashboard URL diversi, la piattaforma potrebbe
 * comportarsi diversamente nei due contesti). Opzionalmente overridabili da
 * config.json (chiavi `dashboardUrl` / `userAgent`); se assenti, si usa il default.
 */

const DEFAULT_DASHBOARD_URL = 'https://tecsial.gsdcampus.it/corso/listAllByUser';
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function dashboardUrl(config) {
  return config && config.dashboardUrl ? config.dashboardUrl : DEFAULT_DASHBOARD_URL;
}

function userAgent(config) {
  return config && config.userAgent ? config.userAgent : DEFAULT_USER_AGENT;
}

module.exports = { DEFAULT_DASHBOARD_URL, DEFAULT_USER_AGENT, dashboardUrl, userAgent };