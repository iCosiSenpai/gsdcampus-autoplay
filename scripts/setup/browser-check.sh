# browser-check.sh — rileva Chrome di sistema e/o Chromium Playwright.
# Sourced da setup/check-requirements (DIR = root progetto).

detect_chrome_app() {
  CHROME_APP=""
  [ -d "/Applications/Google Chrome.app" ] && CHROME_APP="/Applications/Google Chrome.app"
  [ -z "$CHROME_APP" ] && [ -d "$HOME/Applications/Google Chrome.app" ] && CHROME_APP="$HOME/Applications/Google Chrome.app"
  [ -n "$CHROME_APP" ]
}

playwright_chromium_ok() {
  node -e "const {chromium}=require('playwright'); const p=chromium.executablePath(); require('fs').accessSync(p); console.log('ok')" >/dev/null 2>&1
}

# Stampa messaggi ok/warn se le funzioni log_ok/log_missing/warn esistono (check-requirements).
# Altrimenti no-op silenzioso.
report_browser_status() {
  if detect_chrome_app; then
    if type log_ok &>/dev/null; then
      log_ok "Google Chrome ($CHROME_APP) — consigliato"
    fi
    return 0
  fi
  if playwright_chromium_ok; then
    if type log_ok &>/dev/null; then
      log_ok "Browser: Chromium Playwright (Chrome assente — fallback automatico, ok)"
    fi
    return 0
  fi
  if type log_missing &>/dev/null; then
    log_missing "Browser (installa Google Chrome OPPURE: npx playwright install chromium / ./scripts/setup.sh)"
  fi
  return 1
}
