import csv
import re
from collections import Counter
from pathlib import Path


SOURCE = Path("/Users/muhammedrisan/Downloads/bookings_formatted.csv")
OUTPUT_DIR = Path("/Users/muhammedrisan/Downloads/Nizan_ERP_CRM/backend/tmp")
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

NORMALIZED_CSV = OUTPUT_DIR / "bookings_formatted_normalized.csv"
REGION_REVIEW_CSV = OUTPUT_DIR / "booking_region_review.csv"
STAFF_REVIEW_CSV = OUTPUT_DIR / "booking_staff_review.csv"
PACKAGE_REVIEW_CSV = OUTPUT_DIR / "booking_package_review.csv"
NIZAN_BOOKINGS_CSV = OUTPUT_DIR / "bookings_formatted_nizan_only.csv"
FMA_BOOKINGS_CSV = OUTPUT_DIR / "bookings_formatted_fma_only.csv"
NIZAN_PACKAGE_REVIEW_CSV = OUTPUT_DIR / "booking_package_review_nizan.csv"
FMA_PACKAGE_REVIEW_CSV = OUTPUT_DIR / "booking_package_review_fma.csv"


REGION_MAP = {
    "CLT": "Kozhikode",
    "CLCT": "Kozhikode",
    "CALICUT": "Kozhikode",
    "CALICT": "Kozhikode",
    "KOZHIKODE": "Kozhikode",
    "KZKD": "Kozhikode",
    "VADAKARA": "Kozhikode",
    "KOILANDY": "Kozhikode",
    "PAYYOLI": "Kozhikode",
    "BALUSSERY": "Kozhikode",
    "CHELANNUR": "Kozhikode",
    "KAKKODI": "Kozhikode",
    "ATHOLI": "Kozhikode",
    "POONOOR": "Kozhikode",
    "THIRUVAMBADY": "Kozhikode",
    "THIRUVMABADY": "Kozhikode",
    "KUNJIPALLY": "Kozhikode",
    "ENGAPUZHA": "Kozhikode",
    "PERAMBRA": "Kozhikode",
    "KOVOOR": "Kozhikode",
    "NANMINDA": "Kozhikode",
    "ERANHIPALAM": "Kozhikode",
    "VENGALI": "Kozhikode",
    "MOKAVOOR": "Kozhikode",
    "KODENCHERRY": "Kozhikode",
    "VEGERI": "Kozhikode",
    "THALI TEMPLE": "Kozhikode",
    "TSR": "Thrissur",
    "THRISSUR": "Thrissur",
    "THRSR": "Thrissur",
    "THRSSR": "Thrissur",
    "TRISSUR": "Thrissur",
    "TRSR": "Thrissur",
    "MANNUTHY": "Thrissur",
    "PUZHAKKAL": "Thrissur",
    "KODAKARA": "Thrissur",
    "KOORKANCHERI": "Thrissur",
    "TRIPRAYAR": "Thrissur",
    "CHERUTHURUTHI": "Thrissur",
    "CHALAKKUDY": "Thrissur",
    "KODUNGALLUR": "Thrissur",
    "PAROOR": "Thrissur",
    "MELETHALAKKAL": "Thrissur",
    "POOMALA": "Thrissur",
    "EKM": "Ernakulam",
    "ERNAKULAM": "Ernakulam",
    "ERNKLM": "Ernakulam",
    "EKLM": "Ernakulam",
    "ERKLM": "Ernakulam",
    "ERKM": "Ernakulam",
    "KOCHI": "Ernakulam",
    "ANGAMALY": "Ernakulam",
    "ALUVA": "Ernakulam",
    "KOTHAMANGALAM": "Ernakulam",
    "NEDUMBASSERY": "Ernakulam",
    "RAMADA RESORT": "Ernakulam",
    "KADAVANTHARA": "Ernakulam",
    "KOLENCHERY": "Ernakulam",
    "PARAVUR": "Ernakulam",
    "KNR": "Kannur",
    "KANNUR": "Kannur",
    "THALASSERY": "Kannur",
    "PAYANUR": "Kannur",
    "EDAKKAD": "Kannur",
    "KELAKAM": "Kannur",
    "MLP": "Malappuram",
    "MLM": "Malappuram",
    "MLPRM": "Malappuram",
    "MLPM": "Malappuram",
    "MALAPPURAM": "Malappuram",
    "MALAPURAM": "Malappuram",
    "NILAMBUR": "Malappuram",
    "MANJERI": "Malappuram",
    "PERINTHALMANNA": "Malappuram",
    "EDAVANNAPARA": "Malappuram",
    "VENGARA": "Malappuram",
    "WANDOOR": "Malappuram",
    "MORAYUR": "Malappuram",
    "AREEKODE": "Malappuram",
    "KURUVA": "Malappuram",
    "PARAPPANANGADI": "Malappuram",
    "PKD": "Palakkad",
    "PLKD": "Palakkad",
    "PALKD": "Palakkad",
    "PALAKKAD": "Palakkad",
    "NEMMARA": "Palakkad",
    "SHORNUR": "Palakkad",
    "SHOURNUR": "Palakkad",
    "VANIYAMKULAM": "Palakkad",
    "KOPPAM": "Palakkad",
    "KTM": "Kottayam",
    "KTYM": "Kottayam",
    "PAMPADY": "Kottayam",
    "KUMARAKOM": "Kottayam",
    "ALP": "Alappuzha",
    "ALPY": "Alappuzha",
    "ALAPPUZHA": "Alappuzha",
    "CHERTHALA": "Alappuzha",
    "KAYAMKULAM": "Alappuzha",
    "PTM": "Pathanamthitta",
    "PATHANAMTHI": "Pathanamthitta",
    "PTNMTHTA": "Pathanamthitta",
    "NOORANAD": "Pathanamthitta",
    "KADAMPANAD": "Pathanamthitta",
    "PARASSALA": "Thiruvananthapuram",
    "TVM": "Thiruvananthapuram",
    "KOLLAM": "Kollam",
    "KLM": "Kollam",
    "WAYANAD": "Wayanad",
    "WAYANADU": "Wayanad",
    "WND": "Wayanad",
    "WYND": "Wayanad",
    "SULTHAN BATHERY": "Wayanad",
    "IDUKKI": "Idukki",
    "IDKI": "Idukki",
    "IDUKI": "Idukki",
    "THODUPUZHA": "Idukki",
    "ADIMALY": "Idukki",
    "KASARGOD": "Kasaragod",
    "KSD": "Kasaragod",
    "GURUVAYOOR": "Thrissur",
    "GURUVAYUR": "Thrissur",
    "GRVYR": "Thrissur",
    "GVR": "Thrissur",
    "GURUVYUR": "Thrissur",
    "GUIRUVAYOOR": "Thrissur",
    "TAMIL NADU": "Tamil Nadu",
    "TAMILNADU": "Tamil Nadu",
    "CHENNAI": "Tamil Nadu",
    "CHENNI": "Tamil Nadu",
    "BANGALORE": "Bengaluru",
    "BANGLORE": "Bengaluru",
    "MYSORE": "Mysuru",
    "KARNATAKA": "Karnataka",
}

STAFF_CANONICAL_MAP = {
    "FMA": "FMA",
    "MEGHA": "Megha",
    "NIHALA": "Nihala",
    "ASWANI": "Aswani",
    "ASWINI": "Aswani",
    "AWANI": "Aswani",
    "ANJALI": "Anjali",
    "ANAJALI": "Anjali",
    "IRFANA": "Irfana",
    "MALU": "Malu",
    "SANDRA": "Sandra",
    "SANDHRA": "Sandra",
    "SANTRA": "Sandra",
    "ANSHITHA": "Anshitha",
    "ANASHITHA": "Anshitha",
    "ANSHIDA": "Anshitha",
    "ANSHIDHA": "Anshitha",
    "FIDHA": "Fidha",
    "FIDA": "Fidha",
    "RIZWANA": "Rizwana",
    "DRISHYA": "Drishya",
    "MONI": "Moni",
    "THASLIYA": "Thasliya",
    "SHAHANA": "Shahana",
    "REEM": "Reem",
    "REEMA": "Reem",
    "ANAGHA": "Anagha",
    "ANASWARA": "Anaswara",
    "ANASWRA": "Anaswara",
    "ANASAWARA": "Anaswara",
    "ANSAWARA": "Anaswara",
    "ANSWARA": "Anaswara",
    "ANJANA": "Anjana",
    "ANAJANA": "Anjana",
    "ALFIYA": "Alfiya",
    "ALFY": "Alfiya",
    "AJILA": "Ajila",
    "AJUBA": "Ajooba",
    "AJOOBA": "Ajooba",
    "NANDHANA": "Nandhana",
    "NANADHANA": "Nandhana",
    "NADHANA": "Nandhana",
    "HIBA": "Hiba",
    "RAMSHITHA": "Ramshitha",
    "DILNA": "Dilna",
    "NIDA": "Nida",
    "MUNEERA": "Muneera",
    "SHAMEENA": "Shameena",
    "SHAHINA": "Shahina",
    "FARSANA": "Farsana",
    "SHAMI": "Shami",
    "SINIYA": "Siniya",
    "SHANA": "Shana",
    "VARSHA": "Varsha",
    "HARSHA": "Harsha",
    "SHALU": "Shalu",
    "SHEENA": "Sheena",
    "JEMSHI": "Jemshi",
    "JASMIN": "Jasmin",
    "JASMINE": "Jasmin",
    "MURSHI": "Murshi",
    "MURSHITHA": "Murshitha",
    "SHAIBA": "Shaiba",
    "MALAVIKA": "Malavika",
    "MALINI": "Malini",
    "JASMI": "Jasmi",
    "MUFEEDHA": "Mufeedha",
    "MUFSIDHA": "Mufeedha",
    "SAWMYA": "Sowmya",
    "SWAWMYA": "Sowmya",
    "AMRITHA": "Amritha",
}

STAFF_STOPWORDS = {
    "",
    "NIL",
    "NILL",
    "NO",
    "NEW",
    "NEW TRAINEE",
    "DRAPIST",
    "SAREE DRAPIST",
    "SAREE DRAPPING",
    "FACE",
    "AST",
    "ASR",
    "SDA",
    "SDP",
    "SD",
    "SDA",
    "HSDA",
    "NADA",
}

STAFF_NOISE_PATTERNS = [
    r"ADD\s*ONS?",
    r"\bPOC\b",
    r"\bPHONE\b",
    r"\bBRIDE\b",
    r"\bDRIVER\b",
    r"\bTOOL\b",
    r"\bCAPTURE\b",
    r"\bREQUIRED\b",
    r"\bROOM\b",
    r"\bLOOK\b",
    r"\bGUEST\b",
    r"\bMAKEUP\b",
    r"\bSAREE\b",
    r"\bMANTHR?A?KODI\b",
]


def clean_key(value: str) -> str:
    return re.sub(r"[^A-Z]", "", value.upper())


REGION_MAP_CLEAN = {clean_key(k): v for k, v in REGION_MAP.items()}
STAFF_CANONICAL_CLEAN = {clean_key(k): v for k, v in STAFF_CANONICAL_MAP.items()}
STAFF_STOPWORDS_CLEAN = {clean_key(v) for v in STAFF_STOPWORDS}


def normalize_region(raw: str) -> str:
    value = (raw or "").strip()
    if not value:
        return ""

    normalized_key = clean_key(value)
    if normalized_key in REGION_MAP_CLEAN:
        return REGION_MAP_CLEAN[normalized_key]

    pieces = [part.strip() for part in re.split(r"[,/]|\band\b", value, flags=re.I)]
    for piece in pieces:
        cleaned_piece = clean_key(piece)
        if cleaned_piece in REGION_MAP_CLEAN:
            return REGION_MAP_CLEAN[cleaned_piece]

    return value.title()


def normalize_staff_list(raw: str):
    value = (raw or "").strip()
    if not value:
        return []

    pieces = re.split(r"[,&/;]|\band\b", value, flags=re.I)
    normalized = []
    seen = set()
    for piece in pieces:
        item = re.sub(r"\(.*?\)", "", piece).strip().strip('"').strip()
        if not item:
            continue
        item = re.sub(r"^ADD ONS\s*:\s*", "", item, flags=re.I).strip()
        item = re.sub(r"^BY\s+", "", item, flags=re.I).strip()
        if any(re.search(pattern, item, flags=re.I) for pattern in STAFF_NOISE_PATTERNS):
            continue
        if re.search(r"\d{3,}", item):
            continue
        cleaned_key = clean_key(item)
        if not cleaned_key or cleaned_key in STAFF_STOPWORDS_CLEAN:
            continue
        name = STAFF_CANONICAL_CLEAN.get(cleaned_key, item.title())
        if name in seen:
            continue
        seen.add(name)
        normalized.append(name)
    return normalized


with SOURCE.open(newline="", encoding="utf-8-sig") as f:
    rows = list(csv.DictReader(f))

normalized_rows = []
region_counter = Counter()
staff_counter = Counter()
package_counter = Counter()
nizan_package_counter = Counter()
fma_package_counter = Counter()
nizan_rows = []
fma_rows = []

for row in rows:
    normalized_region = normalize_region(row.get("location_area", ""))
    normalized_staff = normalize_staff_list(row.get("staff_needed", ""))
    raw_package = (row.get("package") or "").strip()

    region_counter[normalized_region or "(blank)"] += 1
    for name in normalized_staff:
        staff_counter[name] += 1
    if raw_package:
        package_counter[raw_package] += 1

    normalized_row = dict(row)
    normalized_row["normalized_region"] = normalized_region
    normalized_row["normalized_staff_needed"] = ", ".join(normalized_staff)
    normalized_rows.append(normalized_row)

    is_fma_row = "FMA" in {
        name.upper() for name in normalized_staff
    } or "FMA" in str(row.get("full_notes") or "").upper()

    if is_fma_row:
        fma_rows.append(normalized_row)
        if raw_package:
            fma_package_counter[raw_package] += 1
    else:
        nizan_rows.append(normalized_row)
        if raw_package:
            nizan_package_counter[raw_package] += 1


with NORMALIZED_CSV.open("w", newline="", encoding="utf-8") as f:
    writer = csv.DictWriter(
        f,
        fieldnames=list(normalized_rows[0].keys()) if normalized_rows else [],
    )
    writer.writeheader()
    writer.writerows(normalized_rows)

for output_path, source_rows in [
    (NIZAN_BOOKINGS_CSV, nizan_rows),
    (FMA_BOOKINGS_CSV, fma_rows),
]:
    with output_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(
            f,
            fieldnames=list(normalized_rows[0].keys()) if normalized_rows else [],
        )
        writer.writeheader()
        writer.writerows(source_rows)

with REGION_REVIEW_CSV.open("w", newline="", encoding="utf-8") as f:
    writer = csv.writer(f)
    writer.writerow(["original_location_area", "normalized_region", "count"])
    original_counter = Counter((row.get("location_area") or "").strip() for row in rows if (row.get("location_area") or "").strip())
    for original, count in sorted(original_counter.items(), key=lambda item: (-item[1], item[0])):
        writer.writerow([original, normalize_region(original), count])

with STAFF_REVIEW_CSV.open("w", newline="", encoding="utf-8") as f:
    writer = csv.writer(f)
    writer.writerow(["normalized_staff_name", "count"])
    for name, count in staff_counter.most_common():
        writer.writerow([name, count])

with PACKAGE_REVIEW_CSV.open("w", newline="", encoding="utf-8") as f:
    writer = csv.writer(f)
    writer.writerow(
        [
            "package_code",
            "count",
            "suggested_name",
            "base_price",
            "advance_amount",
            "description",
        ]
    )
    for code, count in package_counter.most_common():
        writer.writerow([code, count, "", "", "3000", ""])

for output_path, counter in [
    (NIZAN_PACKAGE_REVIEW_CSV, nizan_package_counter),
    (FMA_PACKAGE_REVIEW_CSV, fma_package_counter),
]:
    with output_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(
            [
                "package_code",
                "count",
                "suggested_name",
                "base_price",
                "advance_amount",
                "description",
            ]
        )
        for code, count in counter.most_common():
            writer.writerow([code, count, "", "", "3000", ""])

print(f"Normalized CSV: {NORMALIZED_CSV}")
print(f"Region review: {REGION_REVIEW_CSV}")
print(f"Staff review: {STAFF_REVIEW_CSV}")
print(f"Package review: {PACKAGE_REVIEW_CSV}")
print(f"Nizan bookings: {NIZAN_BOOKINGS_CSV}")
print(f"FMA bookings: {FMA_BOOKINGS_CSV}")
print(f"Nizan package review: {NIZAN_PACKAGE_REVIEW_CSV}")
print(f"FMA package review: {FMA_PACKAGE_REVIEW_CSV}")
