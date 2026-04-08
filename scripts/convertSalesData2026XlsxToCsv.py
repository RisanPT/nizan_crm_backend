import csv
import sys
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

NS = {
    "a": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "pr": "http://schemas.openxmlformats.org/package/2006/relationships",
}

SHEET_NAME = "Sale Data 2026"


def col_to_index(col: str) -> int:
    result = 0
    for ch in col:
        if ch.isalpha():
            result = result * 26 + (ord(ch.upper()) - 64)
    return result - 1


def ensure_list(value):
    if value is None:
        return []
    if isinstance(value, list):
        return value
    return [value]


def read_sheet_rows(xlsx_path: Path):
    with zipfile.ZipFile(xlsx_path) as zf:
        shared_strings = []
        if "xl/sharedStrings.xml" in zf.namelist():
            root = ET.fromstring(zf.read("xl/sharedStrings.xml"))
            for si in root.findall("a:si", NS):
                text = "".join(node.text or "" for node in si.iterfind(".//a:t", NS))
                shared_strings.append(text)

        workbook = ET.fromstring(zf.read("xl/workbook.xml"))
        rels = ET.fromstring(zf.read("xl/_rels/workbook.xml.rels"))
        rel_map = {
            rel.attrib["Id"]: rel.attrib["Target"]
            for rel in rels.findall("pr:Relationship", NS)
        }

        sheet_path = None
        for sheet in workbook.find("a:sheets", NS):
            if sheet.attrib.get("name") == SHEET_NAME:
                rid = sheet.attrib[
                    "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
                ]
                target = rel_map[rid].lstrip("/")
                sheet_path = target if target.startswith("xl/") else f"xl/{target}"
                break

        if not sheet_path:
            raise RuntimeError(f'Sheet "{SHEET_NAME}" not found')

        root = ET.fromstring(zf.read(sheet_path))
        rows = []
        for row in root.findall(".//a:sheetData/a:row", NS):
            cells = {}
            for cell in row.findall("a:c", NS):
                ref = cell.attrib.get("r", "")
                col = "".join(ch for ch in ref if ch.isalpha())
                idx = col_to_index(col)
                cell_type = cell.attrib.get("t")
                value = ""
                if cell_type == "s":
                    v = cell.find("a:v", NS)
                    if v is not None and v.text is not None:
                        value = shared_strings[int(v.text)]
                elif cell_type == "inlineStr":
                    inline = cell.find("a:is", NS)
                    if inline is not None:
                        value = "".join(
                            node.text or "" for node in inline.iterfind(".//a:t", NS)
                        )
                else:
                    v = cell.find("a:v", NS)
                    if v is not None and v.text is not None:
                        value = v.text
                cells[idx] = value
            max_idx = max(cells) if cells else -1
            rows.append([cells.get(i, "") for i in range(max_idx + 1)])
        return rows


def main():
    if len(sys.argv) < 3:
        print("Usage: python3 convertSalesData2026XlsxToCsv.py <input.xlsx> <output.csv>")
        sys.exit(1)

    xlsx_path = Path(sys.argv[1]).expanduser().resolve()
    csv_path = Path(sys.argv[2]).expanduser().resolve()

    rows = read_sheet_rows(xlsx_path)
    csv_path.parent.mkdir(parents=True, exist_ok=True)

    with csv_path.open("w", newline="", encoding="utf-8") as csv_file:
        writer = csv.writer(csv_file)
        writer.writerows(rows)

    print(csv_path)


if __name__ == "__main__":
    main()
