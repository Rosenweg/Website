<?php
require_once("backend/vcarddir/vcarddir.php");
// Rosenweg: vcarddir-Inhalt (gemeinsamer read-only Ordner) + LDAP-Auth gegen Authentik
class BackendRosenweg extends BackendVCardDir {
    public function Logon($username, $domain, $password) {
        if (!$username || !$password) { ZLog::Write(LOGLEVEL_WARN, "BackendRosenweg: empty creds"); return false; }
        $conn = @ldap_connect("ldap://100.64.2.37:389");
        if (!$conn) { ZLog::Write(LOGLEVEL_ERROR, "BackendRosenweg: ldap_connect failed"); return false; }
        ldap_set_option($conn, LDAP_OPT_PROTOCOL_VERSION, 3);
        ldap_set_option($conn, LDAP_OPT_REFERRALS, 0);
        ldap_set_option($conn, LDAP_OPT_NETWORK_TIMEOUT, 6);
        $esc = str_replace(array('\\',',','+','"','<','>',';','='), array('\\\\','\\,','\\+','\\"','\\<','\\>','\;','\\='), $username);
        $dn = "cn=".$esc.",ou=users,dc=rosenweg4303,dc=ch";
        $ok = @ldap_bind($conn, $dn, $password);
        @ldap_unbind($conn);
        if (!$ok) { ZLog::Write(LOGLEVEL_WARN, "BackendRosenweg: LDAP bind failed for ".$username); return false; }
        ZLog::Write(LOGLEVEL_INFO, "BackendRosenweg: LDAP OK ".$username);
        return parent::Logon($username, $domain, $password);
    }
    public function GetSupportedASVersion() {
        return ZPush::ASV_141;
    }
}
