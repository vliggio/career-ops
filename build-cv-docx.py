#!/usr/bin/env python3
"""Render an ATS CV payload (the same JSON build-cv-html.mjs consumes) to .docx.

Why this exists: modes/_custom.md requires a .docx alongside every PDF run,
because Workday parses .docx more reliably than PDF. There is no pandoc or
LibreOffice on this machine and no npm docx dependency, so this writes minimal
Office Open XML directly. Deterministic, no third-party packages.

Usage: python3 build-cv-docx.py <ats-payload.json> <out.docx>
"""
import json, sys, zipfile
from xml.sax.saxutils import escape

def p(text, style=None, bold=False, size=None):
    rpr = ""
    if bold:
        rpr += "<w:b/>"
    if size:
        rpr += f'<w:sz w:val="{size}"/><w:szCs w:val="{size}"/>'
    rpr = f"<w:rPr>{rpr}</w:rPr>" if rpr else ""
    ppr = f'<w:pPr><w:pStyle w:val="{style}"/></w:pPr>' if style else ""
    return f'<w:p>{ppr}<w:r>{rpr}<w:t xml:space="preserve">{escape(text)}</w:t></w:r></w:p>'

def bullet(text):
    ppr = ('<w:pPr><w:pStyle w:val="ListParagraph"/>'
           '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>')
    return f'<w:p>{ppr}<w:r><w:t xml:space="preserve">{escape(text)}</w:t></w:r></w:p>'

def build(d):
    c = d["candidate"]
    body = [p(c["name"], bold=True, size="36")]
    contact = " | ".join(x for x in [
        c.get("location"), c.get("phone"), c.get("email"),
        (c.get("linkedin") or {}).get("display"), (c.get("github") or {}).get("display"),
    ] if x)
    body.append(p(contact))

    if d.get("summary"):
        body += [p("Summary", bold=True, size="28"), p(d["summary"])]

    if d.get("skills"):
        body.append(p("Skills", bold=True, size="28"))
        for s in d["skills"]:
            items = s["items"]
            if isinstance(items, list):
                items = ", ".join(items)
            body.append(p(f'{s["category"]}: {items}'))

    if d.get("experience"):
        body.append(p("Professional Experience", bold=True, size="28"))
        for e in d["experience"]:
            body.append(p(e["company"], bold=True))
            line = e["role"]
            if e.get("location"):
                line += f' | {e["location"]}'
            body.append(p(line))
            body.append(p(e["dates"]))
            for b in e.get("bullets", []):
                body.append(bullet(b))

    if d.get("education"):
        body.append(p("Education", bold=True, size="28"))
        for e in d["education"]:
            bits = [e.get("title"), e.get("org"), e.get("year")]
            body.append(p(", ".join(x for x in bits if x)))

    if d.get("certifications"):
        body.append(p("Certifications", bold=True, size="28"))
        for e in d["certifications"]:
            bits = [e.get("title"), e.get("org"), e.get("year")]
            body.append(p(", ".join(x for x in bits if x)))

    if d.get("awards"):
        body.append(p("Additional", bold=True, size="28"))
        for e in d["awards"]:
            bits = [e.get("title"), e.get("org"), e.get("year")]
            body.append(p(", ".join(x for x in bits if x)))

    return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
            f'<w:body>{"".join(body)}'
            '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>'
            '<w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720"/></w:sectPr>'
            '</w:body></w:document>')

STYLES = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
 '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
 '<w:docDefaults><w:rPrDefault><w:rPr>'
 '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>'
 '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/></w:style>'
 '</w:styles>')

NUMBERING = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
 '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
 '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0">'
 '<w:numFmt w:val="bullet"/><w:lvlText w:val="•"/>'
 '<w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr>'
 '<w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol"/></w:rPr></w:lvl></w:abstractNum>'
 '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>')

CT = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
 '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
 '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
 '<Default Extension="xml" ContentType="application/xml"/>'
 '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
 '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
 '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>'
 '</Types>')

RELS = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
 '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
 '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
 '</Relationships>')

DOCRELS = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
 '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
 '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
 '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>'
 '</Relationships>')

def main():
    if len(sys.argv) != 3:
        print(__doc__); sys.exit(1)
    d = json.load(open(sys.argv[1]))
    with zipfile.ZipFile(sys.argv[2], "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", CT)
        z.writestr("_rels/.rels", RELS)
        z.writestr("word/_rels/document.xml.rels", DOCRELS)
        z.writestr("word/document.xml", build(d))
        z.writestr("word/styles.xml", STYLES)
        z.writestr("word/numbering.xml", NUMBERING)
    print(f"docx written: {sys.argv[2]}")

if __name__ == "__main__":
    main()
