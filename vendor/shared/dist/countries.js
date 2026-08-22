// packages/shared/src/countries.ts
//
// THE canonical country dataset — one list, both apps.
//
// ══════════════════════════════════════════════════════════════════════
// WHY THIS EXISTS: THERE WERE TWO LISTS, AND NEITHER WAS SUFFICIENT.
// ══════════════════════════════════════════════════════════════════════
//   apps/frontend/src/data/countries.ts   249 × {code, name}
//       Complete ISO 3166-1, but names only — no demonym, no ISO3, no
//       aliases, so nothing could resolve free text against it.
//
//   apps/backend/src/utils/countryCodes.ts  120 × {iso2, iso3, region,
//       name, demonym, aliases}
//       Rich enough to resolve "Indian" → IN, but scoped to the visa
//       catalogue's destinations. A consumer's country of residence or
//       place of birth is not a visa destination, so 129 real countries
//       had no entry at all.
//
// This file is the MERGE: all 249, with the richer fields layered onto
// the 120 that have them. countries.ts turned out to be a strict superset
// of countryCodes.ts by ISO2 — nothing was dropped in the merge.
//
// ── WHY BOTH `name` AND `commonName` ─────────────────────────────────
// The two sources disagreed on exactly six names:
//
//     iso2   name (ISO 3166)                    commonName
//     VN     Viet Nam                           Vietnam
//     LA     Lao People's Democratic Republic   Laos
//     BN     Brunei Darussalam                  Brunei
//     KR     Korea, Republic of                 South Korea
//     RU     Russian Federation                 Russia
//     CZ     Czechia                            (see below)
//
// Five of those read better as the visa catalogue's name, so it is kept
// as `commonName` and getCountryDisplayName() prefers it.
//
// CZ is the exception that proves the field needs a definition. The visa
// catalogue says "Czech Republic", which is the DATED form — "Czechia"
// is the current preferred short name and is what ISO already carries.
// So `commonName` is defined here as "the more widely recognised DISPLAY
// form", and by that definition CZ has none: "Czech Republic" is a name
// people still type, which makes it an ALIAS (it must resolve) but not a
// label (it should not be rendered). Filing it that way is what lets
// `commonName ?? name` be correct all six times without an override
// table sitting beside the data contradicting it.
//
// getCountryName()        → `name`, the ISO form. What the B2B
//                            CountryPicker has always rendered; unchanged
//                            so those six screens do not shift.
// getCountryDisplayName() → `commonName ?? name`. What a CONSUMER surface
//                            shows: Vietnam, South Korea, Russia, Czechia.
//
// ── THE RESOLVER TAKES BOTH ──────────────────────────────────────────
// normaliseToIso2() indexes iso2, iso3, BOTH names, the demonym and every
// alias. Its key set is therefore a strict superset of the one in
// apps/backend/src/utils/countryCodes.ts, so no input that resolved
// before can stop resolving — it can only resolve MORE (the 129 countries
// that previously had no entry now match by name).
//
// Normalisation is deliberately identical to countryCodes.ts's, including
// what it does NOT do: there is no diacritic folding. "Türkiye" resolves
// because it is a literal alias, not because "ü" is folded to "u". Adding
// folding would be a behaviour change, so it is not made here.
export const VISA_COUNTRY_REGIONS = [
    "GULF", "MIDDLE_EAST", "SOUTHEAST_ASIA", "SCHENGEN", "EUROPE", "AMERICAS",
    "OCEANIA", "EAST_ASIA", "SOUTH_ASIA", "AFRICA", "CENTRAL_ASIA",
];
/** All 249, in ISO-name order — the order a picker should render. */
export const COUNTRIES = [
    { iso2: "AF", name: "Afghanistan" },
    { iso2: "AX", name: "Åland Islands" },
    { iso2: "AL", name: "Albania", iso3: "ALB", demonym: "Albanian", region: "EUROPE" },
    { iso2: "DZ", name: "Algeria", iso3: "DZA", demonym: "Algerian", region: "AFRICA" },
    { iso2: "AS", name: "American Samoa" },
    { iso2: "AD", name: "Andorra" },
    { iso2: "AO", name: "Angola" },
    { iso2: "AI", name: "Anguilla" },
    { iso2: "AQ", name: "Antarctica" },
    { iso2: "AG", name: "Antigua and Barbuda" },
    { iso2: "AR", name: "Argentina", iso3: "ARG", demonym: "Argentine", region: "AMERICAS", aliases: ["Argentinian"] },
    { iso2: "AM", name: "Armenia", iso3: "ARM", demonym: "Armenian", region: "CENTRAL_ASIA" },
    { iso2: "AW", name: "Aruba" },
    { iso2: "AU", name: "Australia", iso3: "AUS", demonym: "Australian", region: "OCEANIA" },
    { iso2: "AT", name: "Austria", iso3: "AUT", demonym: "Austrian", region: "SCHENGEN" },
    { iso2: "AZ", name: "Azerbaijan", iso3: "AZE", demonym: "Azerbaijani", region: "CENTRAL_ASIA", aliases: ["Azeri"] },
    { iso2: "BS", name: "Bahamas" },
    { iso2: "BH", name: "Bahrain", iso3: "BHR", demonym: "Bahraini", region: "GULF" },
    { iso2: "BD", name: "Bangladesh", iso3: "BGD", demonym: "Bangladeshi", region: "SOUTH_ASIA" },
    { iso2: "BB", name: "Barbados" },
    { iso2: "BY", name: "Belarus" },
    { iso2: "BE", name: "Belgium", iso3: "BEL", demonym: "Belgian", region: "SCHENGEN" },
    { iso2: "BZ", name: "Belize" },
    { iso2: "BJ", name: "Benin" },
    { iso2: "BM", name: "Bermuda" },
    { iso2: "BT", name: "Bhutan", iso3: "BTN", demonym: "Bhutanese", region: "SOUTH_ASIA" },
    { iso2: "BO", name: "Bolivia" },
    { iso2: "BQ", name: "Bonaire, Sint Eustatius and Saba" },
    { iso2: "BA", name: "Bosnia and Herzegovina", iso3: "BIH", demonym: "Bosnian", region: "EUROPE", aliases: ["Bosnia & Herzegovina", "Bosnia"] },
    { iso2: "BW", name: "Botswana", iso3: "BWA", demonym: "Motswana", region: "AFRICA", aliases: ["Batswana", "Botswanan"] },
    { iso2: "BV", name: "Bouvet Island" },
    { iso2: "BR", name: "Brazil", iso3: "BRA", demonym: "Brazilian", region: "AMERICAS" },
    { iso2: "IO", name: "British Indian Ocean Territory" },
    { iso2: "BN", name: "Brunei Darussalam", commonName: "Brunei", iso3: "BRN", demonym: "Bruneian", region: "SOUTHEAST_ASIA" },
    { iso2: "BG", name: "Bulgaria", iso3: "BGR", demonym: "Bulgarian", region: "SCHENGEN" },
    { iso2: "BF", name: "Burkina Faso" },
    { iso2: "BI", name: "Burundi" },
    { iso2: "CV", name: "Cabo Verde" },
    { iso2: "KH", name: "Cambodia", iso3: "KHM", demonym: "Cambodian", region: "SOUTHEAST_ASIA" },
    { iso2: "CM", name: "Cameroon" },
    { iso2: "CA", name: "Canada", iso3: "CAN", demonym: "Canadian", region: "AMERICAS" },
    { iso2: "KY", name: "Cayman Islands" },
    { iso2: "CF", name: "Central African Republic" },
    { iso2: "TD", name: "Chad" },
    { iso2: "CL", name: "Chile", iso3: "CHL", demonym: "Chilean", region: "AMERICAS" },
    { iso2: "CN", name: "China", iso3: "CHN", demonym: "Chinese", region: "EAST_ASIA" },
    { iso2: "CX", name: "Christmas Island" },
    { iso2: "CC", name: "Cocos (Keeling) Islands" },
    { iso2: "CO", name: "Colombia", iso3: "COL", demonym: "Colombian", region: "AMERICAS" },
    { iso2: "KM", name: "Comoros" },
    { iso2: "CG", name: "Congo" },
    { iso2: "CD", name: "Congo, Democratic Republic of the" },
    { iso2: "CK", name: "Cook Islands" },
    { iso2: "CR", name: "Costa Rica", iso3: "CRI", demonym: "Costa Rican", region: "AMERICAS" },
    { iso2: "CI", name: "Côte d'Ivoire" },
    { iso2: "HR", name: "Croatia", iso3: "HRV", demonym: "Croatian", region: "SCHENGEN" },
    { iso2: "CU", name: "Cuba", iso3: "CUB", demonym: "Cuban", region: "AMERICAS" },
    { iso2: "CW", name: "Curaçao" },
    { iso2: "CY", name: "Cyprus", iso3: "CYP", demonym: "Cypriot", region: "EUROPE" },
    // "Czech Republic" is an ALIAS here, not a commonName — see the header's
    // note on why CZ is the one row where the visa catalogue's name is the
    // dated form rather than the friendlier one.
    { iso2: "CZ", name: "Czechia", iso3: "CZE", demonym: "Czech", region: "SCHENGEN", aliases: ["Czech Republic"] },
    { iso2: "DK", name: "Denmark", iso3: "DNK", demonym: "Danish", region: "SCHENGEN" },
    { iso2: "DJ", name: "Djibouti" },
    { iso2: "DM", name: "Dominica" },
    { iso2: "DO", name: "Dominican Republic" },
    { iso2: "EC", name: "Ecuador", iso3: "ECU", demonym: "Ecuadorian", region: "AMERICAS", aliases: ["Ecuadorean"] },
    { iso2: "EG", name: "Egypt", iso3: "EGY", demonym: "Egyptian", region: "AFRICA" },
    { iso2: "SV", name: "El Salvador" },
    { iso2: "GQ", name: "Equatorial Guinea" },
    { iso2: "ER", name: "Eritrea" },
    { iso2: "EE", name: "Estonia", iso3: "EST", demonym: "Estonian", region: "SCHENGEN" },
    { iso2: "SZ", name: "Eswatini" },
    { iso2: "ET", name: "Ethiopia", iso3: "ETH", demonym: "Ethiopian", region: "AFRICA" },
    { iso2: "FK", name: "Falkland Islands (Malvinas)" },
    { iso2: "FO", name: "Faroe Islands" },
    { iso2: "FJ", name: "Fiji", iso3: "FJI", demonym: "Fijian", region: "OCEANIA" },
    { iso2: "FI", name: "Finland", iso3: "FIN", demonym: "Finnish", region: "SCHENGEN" },
    { iso2: "FR", name: "France", iso3: "FRA", demonym: "French", region: "SCHENGEN" },
    { iso2: "GF", name: "French Guiana" },
    { iso2: "PF", name: "French Polynesia" },
    { iso2: "TF", name: "French Southern Territories" },
    { iso2: "GA", name: "Gabon" },
    { iso2: "GM", name: "Gambia" },
    { iso2: "GE", name: "Georgia", iso3: "GEO", demonym: "Georgian", region: "CENTRAL_ASIA" },
    { iso2: "DE", name: "Germany", iso3: "DEU", demonym: "German", region: "SCHENGEN" },
    { iso2: "GH", name: "Ghana", iso3: "GHA", demonym: "Ghanaian", region: "AFRICA" },
    { iso2: "GI", name: "Gibraltar" },
    { iso2: "GR", name: "Greece", iso3: "GRC", demonym: "Greek", region: "SCHENGEN" },
    { iso2: "GL", name: "Greenland" },
    { iso2: "GD", name: "Grenada" },
    { iso2: "GP", name: "Guadeloupe" },
    { iso2: "GU", name: "Guam" },
    { iso2: "GT", name: "Guatemala" },
    { iso2: "GG", name: "Guernsey" },
    { iso2: "GN", name: "Guinea" },
    { iso2: "GW", name: "Guinea-Bissau" },
    { iso2: "GY", name: "Guyana" },
    { iso2: "HT", name: "Haiti" },
    { iso2: "HM", name: "Heard Island and McDonald Islands" },
    { iso2: "VA", name: "Holy See" },
    { iso2: "HN", name: "Honduras" },
    { iso2: "HK", name: "Hong Kong", iso3: "HKG", demonym: "Hong Konger", region: "EAST_ASIA", aliases: ["Hong Kong SAR"] },
    { iso2: "HU", name: "Hungary", iso3: "HUN", demonym: "Hungarian", region: "SCHENGEN" },
    { iso2: "IS", name: "Iceland", iso3: "ISL", demonym: "Icelandic", region: "SCHENGEN" },
    { iso2: "IN", name: "India", iso3: "IND", demonym: "Indian", region: "SOUTH_ASIA" },
    { iso2: "ID", name: "Indonesia", iso3: "IDN", demonym: "Indonesian", region: "SOUTHEAST_ASIA" },
    { iso2: "IR", name: "Iran", iso3: "IRN", demonym: "Iranian", region: "MIDDLE_EAST" },
    { iso2: "IQ", name: "Iraq", iso3: "IRQ", demonym: "Iraqi", region: "MIDDLE_EAST" },
    { iso2: "IE", name: "Ireland", iso3: "IRL", demonym: "Irish", region: "EUROPE" },
    { iso2: "IM", name: "Isle of Man" },
    { iso2: "IL", name: "Israel", iso3: "ISR", demonym: "Israeli", region: "MIDDLE_EAST" },
    { iso2: "IT", name: "Italy", iso3: "ITA", demonym: "Italian", region: "SCHENGEN" },
    { iso2: "JM", name: "Jamaica" },
    { iso2: "JP", name: "Japan", iso3: "JPN", demonym: "Japanese", region: "EAST_ASIA" },
    { iso2: "JE", name: "Jersey" },
    { iso2: "JO", name: "Jordan", iso3: "JOR", demonym: "Jordanian", region: "MIDDLE_EAST" },
    { iso2: "KZ", name: "Kazakhstan", iso3: "KAZ", demonym: "Kazakhstani", region: "CENTRAL_ASIA", aliases: ["Kazakh"] },
    { iso2: "KE", name: "Kenya", iso3: "KEN", demonym: "Kenyan", region: "AFRICA" },
    { iso2: "KI", name: "Kiribati" },
    { iso2: "KP", name: "Korea, Democratic People's Republic of" },
    { iso2: "KR", name: "Korea, Republic of", commonName: "South Korea", iso3: "KOR", demonym: "South Korean", region: "EAST_ASIA", aliases: ["Korea", "Republic of Korea", "Korean"] },
    { iso2: "KW", name: "Kuwait", iso3: "KWT", demonym: "Kuwaiti", region: "GULF" },
    { iso2: "KG", name: "Kyrgyzstan", iso3: "KGZ", demonym: "Kyrgyzstani", region: "CENTRAL_ASIA", aliases: ["Kyrgyz"] },
    { iso2: "LA", name: "Lao People's Democratic Republic", commonName: "Laos", iso3: "LAO", demonym: "Laotian", region: "SOUTHEAST_ASIA" },
    { iso2: "LV", name: "Latvia", iso3: "LVA", demonym: "Latvian", region: "SCHENGEN" },
    { iso2: "LB", name: "Lebanon", iso3: "LBN", demonym: "Lebanese", region: "MIDDLE_EAST" },
    { iso2: "LS", name: "Lesotho" },
    { iso2: "LR", name: "Liberia" },
    { iso2: "LY", name: "Libya" },
    { iso2: "LI", name: "Liechtenstein", iso3: "LIE", demonym: "Liechtensteiner", region: "SCHENGEN", aliases: ["Liechtensteinian"] },
    { iso2: "LT", name: "Lithuania", iso3: "LTU", demonym: "Lithuanian", region: "SCHENGEN" },
    { iso2: "LU", name: "Luxembourg", iso3: "LUX", demonym: "Luxembourgish", region: "SCHENGEN" },
    { iso2: "MO", name: "Macao" },
    { iso2: "MG", name: "Madagascar" },
    { iso2: "MW", name: "Malawi" },
    { iso2: "MY", name: "Malaysia", iso3: "MYS", demonym: "Malaysian", region: "SOUTHEAST_ASIA" },
    { iso2: "MV", name: "Maldives", iso3: "MDV", demonym: "Maldivian", region: "SOUTH_ASIA" },
    { iso2: "ML", name: "Mali" },
    { iso2: "MT", name: "Malta", iso3: "MLT", demonym: "Maltese", region: "SCHENGEN" },
    { iso2: "MH", name: "Marshall Islands" },
    { iso2: "MQ", name: "Martinique" },
    { iso2: "MR", name: "Mauritania" },
    { iso2: "MU", name: "Mauritius", iso3: "MUS", demonym: "Mauritian", region: "AFRICA" },
    { iso2: "YT", name: "Mayotte" },
    { iso2: "MX", name: "Mexico", iso3: "MEX", demonym: "Mexican", region: "AMERICAS" },
    { iso2: "FM", name: "Micronesia, Federated States of" },
    { iso2: "MD", name: "Moldova", iso3: "MDA", demonym: "Moldovan", region: "EUROPE" },
    { iso2: "MC", name: "Monaco" },
    { iso2: "MN", name: "Mongolia", iso3: "MNG", demonym: "Mongolian", region: "EAST_ASIA" },
    { iso2: "ME", name: "Montenegro", iso3: "MNE", demonym: "Montenegrin", region: "EUROPE" },
    { iso2: "MS", name: "Montserrat" },
    { iso2: "MA", name: "Morocco", iso3: "MAR", demonym: "Moroccan", region: "AFRICA" },
    { iso2: "MZ", name: "Mozambique" },
    { iso2: "MM", name: "Myanmar", iso3: "MMR", demonym: "Burmese", region: "SOUTHEAST_ASIA", aliases: ["Burma"] },
    { iso2: "NA", name: "Namibia", iso3: "NAM", demonym: "Namibian", region: "AFRICA" },
    { iso2: "NR", name: "Nauru" },
    { iso2: "NP", name: "Nepal", iso3: "NPL", demonym: "Nepali", region: "SOUTH_ASIA", aliases: ["Nepalese"] },
    { iso2: "NL", name: "Netherlands", iso3: "NLD", demonym: "Dutch", region: "SCHENGEN", aliases: ["Holland"] },
    { iso2: "NC", name: "New Caledonia" },
    { iso2: "NZ", name: "New Zealand", iso3: "NZL", demonym: "New Zealander", region: "OCEANIA", aliases: ["Kiwi"] },
    { iso2: "NI", name: "Nicaragua" },
    { iso2: "NE", name: "Niger" },
    { iso2: "NG", name: "Nigeria", iso3: "NGA", demonym: "Nigerian", region: "AFRICA" },
    { iso2: "NU", name: "Niue" },
    { iso2: "NF", name: "Norfolk Island" },
    { iso2: "MK", name: "North Macedonia", iso3: "MKD", demonym: "Macedonian", region: "EUROPE", aliases: ["North Macedonian"] },
    { iso2: "MP", name: "Northern Mariana Islands" },
    { iso2: "NO", name: "Norway", iso3: "NOR", demonym: "Norwegian", region: "SCHENGEN" },
    { iso2: "OM", name: "Oman", iso3: "OMN", demonym: "Omani", region: "GULF" },
    { iso2: "PK", name: "Pakistan", iso3: "PAK", demonym: "Pakistani", region: "SOUTH_ASIA" },
    { iso2: "PW", name: "Palau" },
    { iso2: "PS", name: "Palestine, State of" },
    { iso2: "PA", name: "Panama", iso3: "PAN", demonym: "Panamanian", region: "AMERICAS" },
    { iso2: "PG", name: "Papua New Guinea", iso3: "PNG", demonym: "Papua New Guinean", region: "OCEANIA", aliases: ["PNG"] },
    { iso2: "PY", name: "Paraguay" },
    { iso2: "PE", name: "Peru", iso3: "PER", demonym: "Peruvian", region: "AMERICAS" },
    { iso2: "PH", name: "Philippines", iso3: "PHL", demonym: "Filipino", region: "SOUTHEAST_ASIA", aliases: ["Filipina"] },
    { iso2: "PN", name: "Pitcairn" },
    { iso2: "PL", name: "Poland", iso3: "POL", demonym: "Polish", region: "SCHENGEN" },
    { iso2: "PT", name: "Portugal", iso3: "PRT", demonym: "Portuguese", region: "SCHENGEN" },
    { iso2: "PR", name: "Puerto Rico" },
    { iso2: "QA", name: "Qatar", iso3: "QAT", demonym: "Qatari", region: "GULF" },
    { iso2: "RE", name: "Réunion" },
    { iso2: "RO", name: "Romania", iso3: "ROU", demonym: "Romanian", region: "SCHENGEN" },
    { iso2: "RU", name: "Russian Federation", commonName: "Russia", iso3: "RUS", demonym: "Russian", region: "EUROPE" },
    { iso2: "RW", name: "Rwanda", iso3: "RWA", demonym: "Rwandan", region: "AFRICA" },
    { iso2: "BL", name: "Saint Barthélemy" },
    { iso2: "SH", name: "Saint Helena, Ascension and Tristan da Cunha" },
    { iso2: "KN", name: "Saint Kitts and Nevis" },
    { iso2: "LC", name: "Saint Lucia" },
    { iso2: "MF", name: "Saint Martin (French part)" },
    { iso2: "PM", name: "Saint Pierre and Miquelon" },
    { iso2: "VC", name: "Saint Vincent and the Grenadines" },
    { iso2: "WS", name: "Samoa", iso3: "WSM", demonym: "Samoan", region: "OCEANIA" },
    { iso2: "SM", name: "San Marino" },
    { iso2: "ST", name: "Sao Tome and Principe" },
    { iso2: "SA", name: "Saudi Arabia", iso3: "SAU", demonym: "Saudi", region: "GULF" },
    { iso2: "SN", name: "Senegal" },
    { iso2: "RS", name: "Serbia", iso3: "SRB", demonym: "Serbian", region: "EUROPE" },
    { iso2: "SC", name: "Seychelles", iso3: "SYC", demonym: "Seychellois", region: "AFRICA" },
    { iso2: "SL", name: "Sierra Leone" },
    { iso2: "SG", name: "Singapore", iso3: "SGP", demonym: "Singaporean", region: "SOUTHEAST_ASIA" },
    { iso2: "SX", name: "Sint Maarten (Dutch part)" },
    { iso2: "SK", name: "Slovakia", iso3: "SVK", demonym: "Slovak", region: "SCHENGEN" },
    { iso2: "SI", name: "Slovenia", iso3: "SVN", demonym: "Slovenian", region: "SCHENGEN" },
    { iso2: "SB", name: "Solomon Islands" },
    { iso2: "SO", name: "Somalia" },
    { iso2: "ZA", name: "South Africa", iso3: "ZAF", demonym: "South African", region: "AFRICA" },
    { iso2: "GS", name: "South Georgia and the South Sandwich Islands" },
    { iso2: "SS", name: "South Sudan" },
    { iso2: "ES", name: "Spain", iso3: "ESP", demonym: "Spanish", region: "SCHENGEN" },
    { iso2: "LK", name: "Sri Lanka", iso3: "LKA", demonym: "Sri Lankan", region: "SOUTH_ASIA" },
    { iso2: "SD", name: "Sudan" },
    { iso2: "SR", name: "Suriname" },
    { iso2: "SJ", name: "Svalbard and Jan Mayen" },
    { iso2: "SE", name: "Sweden", iso3: "SWE", demonym: "Swedish", region: "SCHENGEN" },
    { iso2: "CH", name: "Switzerland", iso3: "CHE", demonym: "Swiss", region: "SCHENGEN" },
    { iso2: "SY", name: "Syrian Arab Republic" },
    { iso2: "TW", name: "Taiwan", iso3: "TWN", demonym: "Taiwanese", region: "EAST_ASIA" },
    { iso2: "TJ", name: "Tajikistan", iso3: "TJK", demonym: "Tajikistani", region: "CENTRAL_ASIA", aliases: ["Tajik"] },
    { iso2: "TZ", name: "Tanzania", iso3: "TZA", demonym: "Tanzanian", region: "AFRICA" },
    { iso2: "TH", name: "Thailand", iso3: "THA", demonym: "Thai", region: "SOUTHEAST_ASIA" },
    { iso2: "TL", name: "Timor-Leste" },
    { iso2: "TG", name: "Togo" },
    { iso2: "TK", name: "Tokelau" },
    { iso2: "TO", name: "Tonga" },
    { iso2: "TT", name: "Trinidad and Tobago" },
    { iso2: "TN", name: "Tunisia", iso3: "TUN", demonym: "Tunisian", region: "AFRICA" },
    { iso2: "TR", name: "Türkiye", iso3: "TUR", demonym: "Turkish", region: "EUROPE", aliases: ["Turkey", "Turkiye"] },
    { iso2: "TM", name: "Turkmenistan", iso3: "TKM", demonym: "Turkmen", region: "CENTRAL_ASIA", aliases: ["Turkmenistani"] },
    { iso2: "TC", name: "Turks and Caicos Islands" },
    { iso2: "TV", name: "Tuvalu" },
    { iso2: "UG", name: "Uganda", iso3: "UGA", demonym: "Ugandan", region: "AFRICA" },
    { iso2: "UA", name: "Ukraine", iso3: "UKR", demonym: "Ukrainian", region: "EUROPE" },
    { iso2: "AE", name: "United Arab Emirates", iso3: "ARE", demonym: "Emirati", region: "GULF", aliases: ["UAE", "Dubai"] },
    { iso2: "GB", name: "United Kingdom", iso3: "GBR", demonym: "British", region: "EUROPE", aliases: ["UK", "Britain", "England"] },
    { iso2: "US", name: "United States", iso3: "USA", demonym: "American", region: "AMERICAS", aliases: ["USA", "United States of America"] },
    { iso2: "UM", name: "United States Minor Outlying Islands" },
    { iso2: "UY", name: "Uruguay", iso3: "URY", demonym: "Uruguayan", region: "AMERICAS" },
    { iso2: "UZ", name: "Uzbekistan", iso3: "UZB", demonym: "Uzbekistani", region: "CENTRAL_ASIA", aliases: ["Uzbek"] },
    { iso2: "VU", name: "Vanuatu", iso3: "VUT", demonym: "Ni-Vanuatu", region: "OCEANIA", aliases: ["Vanuatuan"] },
    { iso2: "VE", name: "Venezuela" },
    { iso2: "VN", name: "Viet Nam", commonName: "Vietnam", iso3: "VNM", demonym: "Vietnamese", region: "SOUTHEAST_ASIA" },
    { iso2: "VG", name: "Virgin Islands (British)" },
    { iso2: "VI", name: "Virgin Islands (U.S.)" },
    { iso2: "WF", name: "Wallis and Futuna" },
    { iso2: "EH", name: "Western Sahara" },
    { iso2: "YE", name: "Yemen" },
    { iso2: "ZM", name: "Zambia", iso3: "ZMB", demonym: "Zambian", region: "AFRICA" },
    { iso2: "ZW", name: "Zimbabwe", iso3: "ZWE", demonym: "Zimbabwean", region: "AFRICA" },
];
const BY_ISO2 = new Map(COUNTRIES.map((c) => [c.iso2, c]));
/**
 * Case-insensitive, whitespace-tolerant key that KEEPS any parenthetical.
 * Strips periods, so "U.A.E." and "Virgin Islands (U.S.)" normalise
 * predictably, then trims and collapses internal whitespace runs.
 */
function exactKey(input) {
    return input
        .replace(/\./g, "")
        .trim()
        .replace(/\s+/g, " ")
        .toUpperCase();
}
/**
 * As above, but ALSO strips a parenthetical qualifier — so "United Arab
 * Emirates(Dubai)" resolves as "United Arab Emirates". The visa checklist
 * PDFs suffix a destination with the emirate/city its consulate covers,
 * and this is what absorbs that.
 *
 * Ported from apps/backend/src/utils/countryCodes.ts, where it was the
 * ONLY key. See the two-tier lookup below for why it is now the second.
 */
function strippedKey(input) {
    return exactKey(input.replace(/\s*\([^)]*\)/g, ""));
}
function indexBy(keyOf) {
    const map = new Map();
    for (const c of COUNTRIES) {
        const keys = [c.iso2, c.iso3, c.name, c.commonName, c.demonym, ...(c.aliases ?? [])];
        for (const key of keys) {
            if (!key)
                continue;
            const k = keyOf(key);
            // First entry wins on collision — the rule countryCodes.ts used.
            if (!map.has(k))
                map.set(k, c.iso2);
        }
    }
    return map;
}
/* ── WHY TWO INDEXES AND NOT ONE ──────────────────────────────────────
 *
 * The old resolver stripped parentheticals from every key, which was safe
 * across 120 visa destinations and is NOT safe across all 249:
 *
 *     Virgin Islands (British)  ─┐
 *                                ├─ both strip to "VIRGIN ISLANDS"
 *     Virgin Islands (U.S.)     ─┘
 *
 * With one index and first-entry-wins, VI resolved to VG — a confidently
 * WRONG country, which is worse than the null this function returns for
 * things it does not know. It is the only such collision in the merged
 * set, and it is a collision the merge created: neither Virgin Islands is
 * a visa destination, so the 120-entry list never had both.
 *
 * So: try the full name first, fall back to the stripped form. An input
 * that names a country exactly wins; the checklist's "(Dubai)" suffix
 * still falls through to the stripped index because no exact key matches
 * it. Bare "Virgin Islands" is genuinely ambiguous and still resolves to
 * VG by the first-wins rule — deterministic, and the caller gave us no
 * way to tell which one they meant. */
const EXACT_LOOKUP = indexBy(exactKey);
const STRIPPED_LOOKUP = indexBy(strippedKey);
/**
 * Resolve ISO2, ISO3, a country name, a common name, a demonym or an
 * alias to ISO 3166-1 alpha-2. Returns null for anything unrecognised —
 * never throws, since this runs on user-entered and OCR'd text.
 */
export function normaliseToIso2(input) {
    if (!input)
        return null;
    const exact = exactKey(input);
    if (!exact)
        return null;
    const hit = EXACT_LOOKUP.get(exact);
    if (hit)
        return hit;
    const stripped = strippedKey(input);
    if (!stripped)
        return null;
    return STRIPPED_LOOKUP.get(stripped) ?? null;
}
/** The full entry, or undefined for an unknown code. */
export function getCountryByIso2(iso2) {
    if (!iso2)
        return undefined;
    return BY_ISO2.get(exactKey(iso2));
}
/**
 * The country's ISO 3166-1 name — "India", "Viet Nam".
 *
 * Null for an unknown code rather than the code itself: a caller that
 * wants a fallback should say so, and returning "ZZ" from a function
 * called getCountryName would put a code on screen where a name belongs.
 */
export function getCountryName(iso2) {
    return getCountryByIso2(iso2)?.name ?? null;
}
/**
 * The name a CONSUMER surface should show — "Vietnam", "South Korea",
 * "Czechia". See the header for why this is `commonName ?? name` and why
 * that is correct for CZ too.
 *
 * Separate from getCountryName() so the B2B screens, which have always
 * rendered the ISO form, do not shift under a consumer-side change.
 */
export function getCountryDisplayName(iso2) {
    const c = getCountryByIso2(iso2);
    if (!c)
        return null;
    return c.commonName ?? c.name;
}
/**
 * The demonym — "Indian" — falling back to the country's DISPLAY name
 * where we hold no demonym.
 *
 * The fallback is the whole point: only 120 of the 249 carry a demonym,
 * so a nationality field backed by the full list would otherwise render
 * nothing for 129 real countries. "Afghanistan" in a Nationality field is
 * slightly off register; blank is a bug.
 */
export function getDemonymOrName(iso2) {
    const c = getCountryByIso2(iso2);
    if (!c)
        return null;
    return c.demonym ?? c.commonName ?? c.name;
}
