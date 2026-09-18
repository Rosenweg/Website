#!/bin/sh
# Wartet, bis eine globale IPv6-Adresse BENUTZBAR ist — nicht nur sichtbar.
#
# Samba bindet beim Start an alle Adressen. Die per Router Advertisement
# zugeteilte IPv6 erscheint zuerst als "tentative": der Kernel prueft noch,
# ob sie im Netz doppelt vergeben ist (DAD, etwa eine Sekunde). An eine
# tentative Adresse laesst sich nicht binden — Samba bricht dann mit
# NT_STATUS_ADDRESS_NOT_ASSOCIATED ab.
#
# Die erste Fassung dieses Skripts pruefte nur, OB eine Adresse da ist. Das
# reichte nicht: am 18.09.2026 um 10:42 war sie sichtbar, aber noch tentative,
# und dc1 scheiterte trotz Warten. Darum jetzt -tentative und -dadfailed:
# nur Adressen zaehlen, deren Pruefung abgeschlossen und bestanden ist.
i=0
while [ "$i" -lt 30 ]; do
  if ip -6 addr show scope global -tentative -dadfailed 2>/dev/null | grep -q "inet6 "; then
    exit 0
  fi
  i=$((i + 1))
  sleep 2
done
# Kein Abbruch: ohne IPv6 soll Samba wenigstens ueber IPv4 starten.
echo "warte-ipv6: nach 60s keine benutzbare globale IPv6 — starte trotzdem" >&2
exit 0
