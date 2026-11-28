#!/usr/bin/env python3
"""Stellt den Aufrufer .github/workflows/app.yml einer Flutter-App auf die Release-
Warteschlange um (Website docs/runner-waechter.md): workflow_dispatch bekommt die Eingabe
veroeffentlichen, und Release-Schluessel gehen auch bei diesem Start weiter. Fuer
scripts/rw-massen-pr.sh (--skript). Idempotent. Aufruf im Repo: rw-aufrufer-warteschlange.py"""
import re, sys
p = '.github/workflows/app.yml'
s = open(p).read()
if 'rosenweg-basis/.github/workflows/app.yml@' not in s:
    print('kein Aufrufer von basis app.yml'); sys.exit(0)
if 'veroeffentlichen:\n        description: Release' in s:
    print('schon umgestellt'); sys.exit(0)
FREI = "github.ref == 'refs/heads/main' && (github.event_name == 'push' || (github.event_name == 'workflow_dispatch' && inputs.veroeffentlichen))"
# 1. Eingabe
if re.search(r'^  workflow_dispatch:\s*$', s, re.M):
    s = re.sub(r'^  workflow_dispatch:\s*\n(    inputs:\n)?', lambda m: '  workflow_dispatch:\n    inputs:\n', s, count=1, flags=re.M) if 'inputs:' not in s.split('workflow_dispatch:')[1].split('\nconcurrency')[0] else s
    s = s.replace('    inputs:\n', '    inputs:\n      veroeffentlichen:\n        description: Release anlegen (nur der Runner-Waechter startet so, Zweig main)\n        type: boolean\n        default: false\n', 1)
else:
    s = s.replace('  push:\n    branches: [main]\n', '  push:\n    branches: [main]\n  workflow_dispatch:\n    inputs:\n      veroeffentlichen:\n        description: Release anlegen (nur der Runner-Waechter startet so, Zweig main)\n        type: boolean\n        default: false\n', 1)
# 2. with: veroeffentlichen
s, n1 = re.subn(r"veroeffentlichen: \$\{\{ github\.event_name == 'push' && github\.ref == 'refs/heads/main' \}\}",
                "veroeffentlichen: ${{ %s }}" % FREI, s)
# 3. Secrets
s, n2 = re.subn(r"github\.event_name == 'push' && github\.ref == 'refs/heads/main' && secrets\.", FREI + " && secrets.", s)
s = s.replace('        default: false\nconcurrency', '        default: false\n\nconcurrency')
open(p, 'w').write(s)
print('umgestellt: with=%d, secrets=%d' % (n1, n2))
