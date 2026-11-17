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
    private function fehlversuche($username) {
        $f = $this->sperrDatei($username);
        $d = @json_decode(@file_get_contents($f), true);
        if (!is_array($d) || !isset($d['seit'], $d['n']) || time() - $d['seit'] > self::SPERRE_FENSTER) return array('seit' => time(), 'n' => 0);
        return $d;
    }
    private function fehlversuchMerken($username) {
        $d = $this->fehlversuche($username);
        $d['n']++;
        @file_put_contents($this->sperrDatei($username), json_encode($d), LOCK_EX);
    }

    public function Logon($username, $domain, $password) {
        if (!$username || !$password) { ZLog::Write(LOGLEVEL_WARN, "BackendRosenweg: empty creds"); return false; }
        // Nur plausible Benutzernamen (Authentik-Username): keine Steuerzeichen, kurz.
        if (strlen($username) > 64 || preg_match('/[\x00-\x1f\x7f]/', $username)) { ZLog::Write(LOGLEVEL_WARN, "BackendRosenweg: ungueltiger Benutzername"); return false; }
        if ($this->fehlversuche($username)['n'] >= self::SPERRE_MAX) {
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
            $this->fehlversuchMerken($username);
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
