#!/usr/bin/env python3
"""Rebuild demo/app/ from the main app (run from the repo root: python3 tools/build_demo.py).

The demo is the main app with:
  * its own IndexedDB databases (demo data never touches real projects on the same computer)
  * no service worker (always loads the latest files)
  * ../demo_sim.js loaded first on every page (simulated GPS, compass and camera)
  * a DEMO badge on the home page and no update button
Hand-written demo files (demo/index.html, demo/demo_sim.js, the sample LandXML) are not touched.
"""
import os, re, shutil, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'demo', 'app')
SKIP = {'sw.js', 'README.md'}


def edit(text, old, new, path, count=1):
    if text.count(old) != count:
        sys.exit(f'build_demo: expected {count}x {old!r} in {path}, found {text.count(old)}')
    return text.replace(old, new)


def main():
    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    os.makedirs(OUT)
    for name in sorted(os.listdir(ROOT)):
        src = os.path.join(ROOT, name)
        if name in SKIP or name.startswith('.') or not os.path.isfile(src):
            continue
        if name.endswith(('.html', '.js', '.png', '.json')):
            shutil.copy2(src, os.path.join(OUT, name))
    shutil.copytree(os.path.join(ROOT, 'lib'), os.path.join(OUT, 'lib'))

    def patch(rel, fn):
        p = os.path.join(OUT, rel)
        with open(p, encoding='utf-8') as f:
            t = f.read()
        t = fn(t, rel)
        with open(p, 'w', encoding='utf-8') as f:
            f.write(t)

    patch('db.js', lambda t, p: edit(edit(edit(t,
        "const FT_DB_NAME = 'FieldToolsDB';", "const FT_DB_NAME = 'FieldToolsDemoDB';", p),
        "indexedDB.open('FieldToolsStationPhotos', 1)", "indexedDB.open('FieldToolsDemoStationPhotos', 1)", p),
        "if ('serviceWorker' in navigator && location.protocol !== 'file:') {", "if (false) { // demo: no service worker", p))
    patch('lib/alignments.js', lambda t, p: edit(t,
        "const AP_DB = 'FieldToolsStationPhotos';", "const AP_DB = 'FieldToolsDemoStationPhotos';", p))

    for name in os.listdir(OUT):
        if name.endswith('.html'):
            patch(name, lambda t, p: re.sub(r'<head>', '<head>\n<script src="../demo_sim.js"></script>', t, count=1))

    badge = '<span style="font-size:0.45em;vertical-align:middle;background:#7c3aed;color:#fff;padding:3px 8px;border-radius:6px;font-weight:900;letter-spacing:0.5px;">DEMO</span>'
    patch('index.html', lambda t, p: edit(edit(t,
        '<h1>Field Tools</h1>', f'<h1>Field Tools {badge}</h1>', p),
        '<div class="update-row">', '<div class="update-row" style="display:none">', p))
    patch('project_manager.html', lambda t, p: edit(t,
        '<a href="beta/slope_stake_home.html" class="btn btn-secondary btn-xs" style="text-decoration:none;">Open in Beta</a>',
        '<span class="data-item-meta">Beta only</span>', p))

    # Sanity: nothing in the copy may still point at the real databases
    for dp, _, files in os.walk(OUT):
        for f in files:
            if f.endswith(('.js', '.html')):
                t = open(os.path.join(dp, f), encoding='utf-8').read()
                for bad in ("'FieldToolsDB'", "'FieldToolsStationPhotos'"):
                    if bad in t:
                        sys.exit(f'build_demo: {bad} still referenced in {os.path.join(dp, f)}')
    print('demo/app rebuilt:', len(os.listdir(OUT)), 'entries')


if __name__ == '__main__':
    main()
