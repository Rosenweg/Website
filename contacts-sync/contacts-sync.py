#!/usr/bin/env python3
import os, json, uuid, re, ssl, base64, urllib.request, subprocess, shutil
ENV={}
for line in open("/root/.contacts-sync.env"):
    line=line.strip()
    if "=" in line and not line.startswith("#"):
        k,v=line.split("=",1); ENV[k]=v.strip()
NS=uuid.UUID("12345678-1234-5678-1234-567812345678")
CTX=ssl.create_default_context(); CTX.check_hostname=False; CTX.verify_mode=ssl.CERT_NONE
PGC=subprocess.check_output("docker ps -q -f name=rosenweg_postgres | head -1",shell=True).decode().strip()
def psql(sql):
    return subprocess.check_output(["docker","exec",PGC,"sh","-c","psql -U $POSTGRES_USER -d $POSTGRES_DB -t -A -c \""+sql+"\""]).decode().strip()
def jq(sql):
    s=psql(sql); return json.loads(s) if s else []
personen=jq("SELECT COALESCE(json_agg(json_build_object('name',name,'tel',telefon,'mobile',mobile,'email',email,'telefone',telefone,'emails',emails,'adresse',adresse)),'[]'::json) FROM personen WHERE COALESCE(name,'')<>''")
verw=jq("SELECT COALESCE(json_agg(json_build_object('firma',firma_name,'tel',telefon,'email',email,'adresse',adresse,'website',website)),'[]'::json) FROM verwaltungen WHERE aktiv")
vkont=jq("SELECT COALESCE(json_agg(json_build_object('firma',v.firma_name,'name',k.name,'funktion',k.funktion,'email',k.email,'tel',k.telefon)),'[]'::json) FROM verwaltungs_kontakte k JOIN verwaltungen v ON v.id=k.verwaltung_id WHERE v.aktiv")
def esc(s):
    s=s or ""; return s.replace("\\","\\\\").replace("\n","\\n").replace(",","\\,").replace(";","\;")
def teltype(n):
    d=n.replace(" ","").replace("-",""); return "CELL" if re.search(r"(\+41|^0|^)7[5-9]\d{7}",d) else "VOICE"
def slug(s): return re.sub(r"[^a-z0-9]+","-",(s or "").lower()).strip("-")
def firmakey(f):
    p=(f or "").split(); return slug(p[0]) if p else "verwaltung"
def vc(uid,fn,fam,giv,tels,mails,adr=None,org=None,url=None,note=None,title=None,cats=("Rosenweg",)):
    L=["BEGIN:VCARD","VERSION:3.0","UID:"+uid,"FN:"+esc(fn),"N:"+esc(fam)+";"+esc(giv)+";;;"]
    if org: L.append("ORG:"+esc(org))
    if title: L.append("TITLE:"+esc(title))
    for t in tels: L.append("TEL;TYPE="+teltype(t)+":"+esc(t))
    for m in mails: L.append("EMAIL;TYPE=INTERNET:"+esc(m))
    if url: L.append("URL:"+esc(url))
    if adr: L.append("ADR;TYPE=WORK:;;"+esc(adr)+";;;;")
    if note: L.append("NOTE:"+esc(note))
    L.append("CATEGORIES:"+",".join(cats)); L.append("END:VCARD")
    return "\r\n".join(L)+"\r\n"
def arr(v):
    out=[]
    if isinstance(v,list):
        for x in v:
            if isinstance(x,str) and x.strip(): out.append(x.strip())
            elif isinstance(x,dict):
                val=x.get("number") or x.get("value") or x.get("nummer") or x.get("address")
                if val: out.append(str(val).strip())
    return out
desired={}
for p in personen:
    name=(p.get("name") or "").strip()
    if not name: continue
    parts=name.split(); fam,giv=(parts[-1]," ".join(parts[:-1])) if len(parts)>1 else (name,"")
    tels=[]; mails=[]
    for t in [p.get("tel"),p.get("mobile")]+arr(p.get("telefone")):
        t=(t or "").strip()
        if t and t not in tels: tels.append(t)
    for m in [p.get("email")]+arr(p.get("emails")):
        m=(m or "").strip()
        if m and m not in mails: mails.append(m)
    if not tels and not mails: continue
    u=str(uuid.uuid5(NS,name))
    desired[u]=vc(u,name,fam,giv,tels,mails,adr=(p.get("adresse") or "").replace("\n",", "))
desired["rosenweg-pbx"]=vc("rosenweg-pbx","Rosenweg","Rosenweg","",["+41 61 551 01 52"],[],note="Telefonzentrale / Technik-Hotline")
for v in verw:
    fk=firmakey(v.get("firma")); u=fk+"-verwaltung"
    desired[u]=vc(u,v.get("firma"),v.get("firma"),"",([v.get("tel")] if v.get("tel") else []),([v.get("email")] if v.get("email") else []),adr=((v.get("adresse") or "").replace("\n",", ") or None),org=v.get("firma"),url=(("https://"+v.get("website")) if v.get("website") else None),note="Verwaltung Rosenweg",cats=("Rosenweg","Verwaltung"))
for k in vkont:
    fk=firmakey(k.get("firma")); nm=(k.get("name") or "").strip()
    if not nm: continue
    parts=nm.split(); fam,giv=(parts[-1]," ".join(parts[:-1])) if len(parts)>1 else (nm,"")
    u=fk+"-"+slug(nm)
    desired[u]=vc(u,nm,fam,giv,([k.get("tel")] if k.get("tel") else []),([k.get("email")] if k.get("email") else []),org=k.get("firma"),title=k.get("funktion"),cats=("Rosenweg","Verwaltung"))
def propfind_uids(base,auth,host):
    r=urllib.request.Request(base,data=b'<?xml version="1.0"?><propfind xmlns="DAV:"><prop><getetag/></prop></propfind>',method="PROPFIND")
    r.add_header("Authorization",auth); r.add_header("Depth","1")
    if host: r.add_header("Host",host)
    try: data=urllib.request.urlopen(r,timeout=30,context=CTX).read().decode("utf-8","ignore")
    except Exception as e: print("  PROPFIND err",e); return set()
    return set(re.findall(r"/([^/]+)\.vcf",data))
def cardreq(method,url,auth,host,body=None):
    r=urllib.request.Request(url,data=(body.encode() if body else None),method=method)
    r.add_header("Authorization",auth)
    if host: r.add_header("Host",host)
    if body: r.add_header("Content-Type","text/vcard; charset=utf-8")
    return r
def carddav_sync(label,base,user,pw,delete_stale,host=None):
    auth="Basic "+base64.b64encode((user+":"+pw).encode()).decode()
    existing=propfind_uids(base,auth,host) if delete_stale else set()
    ok=0
    for uid,bd in desired.items():
        try: urllib.request.urlopen(cardreq("PUT",base+uid+".vcf",auth,host,bd),timeout=20,context=CTX); ok+=1
        except urllib.error.HTTPError as e:
            if e.code in (200,201,204): ok+=1
            else: print("  PUT",uid,e.code)
        except Exception as e: print("  PUT",uid,e)
    dl=0
    if delete_stale:
        for uid in existing-set(desired):
            try: urllib.request.urlopen(cardreq("DELETE",base+uid+".vcf",auth,host),timeout=20,context=CTX); dl+=1
            except Exception: pass
    print("  "+label+": put="+str(ok)+" del="+str(dl))
print("desired:",len(desired))
carddav_sync("Nextcloud","http://100.64.2.36/remote.php/dav/addressbooks/users/kontakte/rosenweg/","kontakte",ENV["NC_KONTAKTE_PW"],True,"nextcloud.rosenweg9.ch")
carddav_sync("SOGo inbox@","https://100.64.2.33/SOGo/dav/inbox@rosenweg4303.ch/Contacts/personal/","inbox@rosenweg4303.ch",ENV["INBOX_PW"],False,"mailcow.rosenweg9.ch")
carddav_sync("SOGo praesident@","https://100.64.2.33/SOGo/dav/praesident@rosenweg4303.ch/Contacts/personal/","praesident@rosenweg4303.ch",ENV["PRAESIDENT_PW"],False,"mailcow.rosenweg9.ch")
TMP="/tmp/zpush-vcards"
if os.path.isdir(TMP): shutil.rmtree(TMP)
os.makedirs(TMP)
for uid,bd in desired.items(): open(TMP+"/"+uid+".vcf","w").write(bd)
subprocess.run("rsync -a --delete -e 'ssh -o StrictHostKeyChecking=accept-new' "+TMP+"/ root@100.64.2.38:/var/lib/zpush-contacts/",shell=True,check=False)
subprocess.run("ssh -o StrictHostKeyChecking=accept-new root@100.64.2.38 chown -R www-data:www-data /var/lib/zpush-contacts",shell=True,check=False)
print("Z-Push CT115: rsynced "+str(len(desired))+" vcards")
print("DONE")
