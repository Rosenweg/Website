#!/bin/bash
# Haelt PMG-Postfix-Settings, die `pmgconfig sync` zuruecksetzt:
#  (1) Outbound: primaerer Relay = eigener VPS (smtp-relay.rosenweg4303.ch, rDNS+SRS),
#      Fallback = SMTP2GO (nur fuer originaere rosenweg-Mail brauchbar).
#  (2) interne Relay-IPs in smtpd/pass/mynetworks (Mailcow/WA-Gateway via PMG raus).
RELAY="[smtp-relay.rosenweg4303.ch]:25"
FALLBACK="[mail.smtp2go.com]:587"
RELOAD=0

if [ "$(postconf -h relayhost 2>/dev/null)" != "$RELAY" ]; then
  postmap hash:/etc/postfix/sasl_passwd 2>/dev/null || true
  postconf "relayhost=$RELAY" \
           "smtp_fallback_relay=$FALLBACK" \
           "smtp_sasl_auth_enable=yes" \
           "smtp_sasl_password_maps=hash:/etc/postfix/sasl_passwd" \
           "smtp_sasl_security_options=noplaintext,noanonymous" \
           "smtp_sasl_tls_security_options=noanonymous" \
           "smtp_tls_security_level=may"
  RELOAD=1
  logger -t pmg-restore-relay "Relay -> VPS ($RELAY), Fallback $FALLBACK"
fi

NEED="100.64.2.33 100.64.2.24 100.64.2.25 100.64.2.26 100.64.2.39"
CUR=$(postconf -Ph smtpd/pass/mynetworks 2>/dev/null | tr -d ' ')
if [ -n "$CUR" ]; then
  NEW="$CUR"
  for ip in $NEED; do echo ",$NEW," | grep -q ",$ip," || NEW="$NEW,$ip"; done
  if [ "$NEW" != "$CUR" ]; then
    postconf -P "smtpd/pass/mynetworks=$NEW"; RELOAD=1
    logger -t pmg-restore-relay "fehlende Relay-IPs ergaenzt -> $NEW"
  fi
fi


# ── (3) Interne Ziele duerfen nicht ins Internet ausweichen ─────────────
#
# smtp_fallback_relay zeigt auf SMTP2GO. Das ist fuer Mail nach draussen
# richtig: Faellt der eigene Relay aus, geht sie trotzdem raus. Fuer
# INTERNE Ziele ist es falsch — und am 1. September 2026 hat es Schaden
# angerichtet: Der WhatsApp-Gateway (100.64.2.39:2525) war einen Moment
# nicht erreichbar, Postfix wich auf SMTP2GO aus, und das lehnte ab, weil
# der Absender gmx.ch dort nicht verifiziert ist. Aus einer Stoerung von
# Sekunden wurde ein endgueltiger Fehlschlag (5.0.0): Die Nachricht war
# verloren, und der Absender bekam eine Meldung, die auf gmx.ch zeigte —
# auf etwas, das mit der Ursache nichts zu tun hatte.
#
# Richtig ist: Ein internes Ziel, das gerade nicht antwortet, wird spaeter
# erneut versucht. Dafuer ein eigener Transport ohne Ausweichziel.
if ! postconf -M 2>/dev/null | grep -q "^intern[[:space:]]"; then
  cat >> /etc/postfix/master.cf <<'MASTER'

# Zustellung an interne Ziele — ohne Ausweichrelay. Ein interner Dienst,
# der kurz schweigt, soll eine Wiederholung ausloesen und keinen Bounce.
intern    unix  -       -       y       -       -       smtp
    -o syslog_name=postfix/intern
    -o smtp_fallback_relay=
MASTER
  logger -t pmg-restore-relay "Transport 'intern' in master.cf ergaenzt"
  RELOAD=1
fi

# Interne Ziele auf diesen Transport umstellen. pmgconfig sync schreibt
# die Datei mit 'smtp:' zurueck — darum steht das hier und nicht einmalig
# von Hand.
if grep -q "smtp:\[100\.64\.2\." /etc/pmg/transport 2>/dev/null; then
  sed -i "s|smtp:\[100\.64\.2\.|intern:[100.64.2.|g" /etc/pmg/transport
  postmap /etc/pmg/transport
  logger -t pmg-restore-relay "interne Transporte auf 'intern' umgestellt (kein Ausweichrelay)"
  RELOAD=1
fi

# Neuladen ZULETZT. Am 1. September 2026 stand diese Zeile in der Mitte,
# und der danach ergaenzte Transport 'intern' wurde nie eingelesen: Postfix
# antwortete "mail transport unavailable" und stellte alle internen Mails
# zurueck. Kein Verlust, aber Stillstand — und schwer zu sehen, weil die
# Konfiguration auf der Platte richtig aussah.
[ "$RELOAD" = "1" ] && { systemctl reload postfix 2>/dev/null || true; }

# Ohne das endet das Skript mit dem Rueckgabewert des letzten Tests. Ist
# nichts zu tun — der Normalfall —, ist der falsch, und systemd liest den
# Dienst als fehlgeschlagen. Am 1. September 2026 so gefunden: Der Dienst
# tat seit jeher das Richtige und meldete trotzdem Misserfolg, was in der
# Dienstwacht als offener Befund stand.
exit 0
