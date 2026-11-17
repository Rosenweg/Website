<?php
require_once("backend/vcarddir/vcarddir.php");
// Rosenweg: vcarddir-Inhalt (gemeinsamer read-only Ordner) + LDAP-Auth gegen Authentik
class BackendRosenweg extends BackendVCardDir {
    // Fehlversuchs-Sperre je Benutzername (D-7, 17.11.2026): jeder Request war
    // ein LDAP-Bind ohne Limit -> Passwortraten gegen Authentik-Konten. Die
    // Quell-IP hilft hier nicht (edge-traefik reicht TCP durch, alle Clients
    // kommen von der Edge-IP) -> Zaehler am Benutzernamen.
    const SPERRE_MAX = 5;          // Fehlversuche ...
    const SPERRE_FENSTER = 900;    // ... in 15 Minuten -> bis Fensterende gesperrt

    private function sperrDatei($username) {
        $dir = (defined('STATE_DIR') ? rtrim(STATE_DIR, '/') : '/var/lib/z-push') . '/rw-logon';
        if (!is_dir($dir)) @mkdir($dir, 0700, true);
        return $dir . '/' . hash('sha256', strtolower($username));
    }
    // Zaehler atomar (R2-Da): Lesen+Hochzaehlen unter einer flock, VOR dem
    // Bind. Sonst laufen parallele Requests alle am Stand n<5 vorbei und die
    // Sperre greift erst nach beliebig vielen gleichzeitigen Versuchen.
    // Rueckgabe false = gesperrt; Erfolg setzt die Datei danach zurueck.
    private function versuchReservieren($username) {
        $f = $this->sperrDatei($username);
        $h = @fopen($f, 'c+');
        if (!$h) {
            // Ablage nicht beschreibbar: wie bisher durchlassen, aber laut melden.
            ZLog::Write(LOGLEVEL_ERROR, "BackendRosenweg: Sperrdatei nicht beschreibbar");
            return true;
        }
        flock($h, LOCK_EX);
        $d = @json_decode(stream_get_contents($h), true);
        if (!is_array($d) || !isset($d['seit'], $d['n']) || time() - $d['seit'] > self::SPERRE_FENSTER) $d = array('seit' => time(), 'n' => 0);
        $frei = $d['n'] < self::SPERRE_MAX;
        if ($frei) {
            $d['n']++;
            ftruncate($h, 0);
            rewind($h);
            fwrite($h, json_encode($d));
            fflush($h);
        }
        flock($h, LOCK_UN);
        fclose($h);
        return $frei;
    }

    public function Logon($username, $domain, $password) {
        if (!$username || !$password) { ZLog::Write(LOGLEVEL_WARN, "BackendRosenweg: empty creds"); return false; }
        // Nur plausible Benutzernamen (Authentik-Username): keine Steuerzeichen, kurz.
        if (strlen($username) > 64 || preg_match('/[\x00-\x1f\x7f]/', $username)) { ZLog::Write(LOGLEVEL_WARN, "BackendRosenweg: ungueltiger Benutzername"); return false; }
        if (!$this->versuchReservieren($username)) {
            ZLog::Write(LOGLEVEL_WARN, "BackendRosenweg: gesperrt (zu viele Fehlversuche) ".$username);
            return false;
        }
        // LDAPS moeglich: RW_LDAP_URI=ldaps://100.64.2.37:636 (php-fpm-Pool: env[RW_LDAP_URI]),
        // dann muss das Zertifikat des Authentik-Outposts gueltig sein (ldap.conf TLS_CACERT).
        $uri = getenv('RW_LDAP_URI') ?: "ldap://100.64.2.37:389";
        $conn = @ldap_connect($uri);
        if (!$conn) { ZLog::Write(LOGLEVEL_ERROR, "BackendRosenweg: ldap_connect failed"); return false; }
        ldap_set_option($conn, LDAP_OPT_PROTOCOL_VERSION, 3);
        ldap_set_option($conn, LDAP_OPT_REFERRALS, 0);
        ldap_set_option($conn, LDAP_OPT_NETWORK_TIMEOUT, 6);
        $esc = str_replace(array('\\',',','+','"','<','>',';','='), array('\\\\','\\,','\\+','\\"','\\<','\\>','\;','\\='), $username);
        $dn = "cn=".$esc.",ou=users,dc=rosenweg4303,dc=ch";
        $ok = @ldap_bind($conn, $dn, $password);
        @ldap_unbind($conn);
        if (!$ok) {
            // Versuch wurde schon vor dem Bind gezaehlt.
            ZLog::Write(LOGLEVEL_WARN, "BackendRosenweg: LDAP bind failed for ".$username);
            return false;
        }
        @unlink($this->sperrDatei($username));
        ZLog::Write(LOGLEVEL_INFO, "BackendRosenweg: LDAP OK ".$username);
        return parent::Logon($username, $domain, $password);
    }
    public function GetSupportedASVersion() {
        return ZPush::ASV_141;
    }
}
