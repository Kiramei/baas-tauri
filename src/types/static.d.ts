export interface StaticConfig {
  steam_app_process_name:             string;
  main_story_final_episode_num:       number;
  main_story_available_episodes:      CurrentGameActivity;
  max_region:                         CurrentGameActivity;
  explore_normal_task_region_range:   number[];
  explore_hard_task_region_range:     number[];
  screenshot_methods:                 string[];
  control_methods:                    string[];
  shop_type_list_names:               LessonRegionName;
  common_shop_price_list:             CommonShopPriceList;
  tactical_challenge_shop_price_list: CurrentGameActivity;
  create_default_priority:            CreateDefaultPriority;
  create_each_phase_weight:           number[];
  create_filter_type_list:            CreateFilterTypeList;
  create_item_order:                  CreateItemOrder;
  create_phase2_recommended_priority: { [key: string]: number[] };
  create_material_information:        { [key: string]: CreateMaterialInformation };
  lesson_region_name:                 LessonRegionName;
  current_game_activity:              CurrentGameActivity;
  dailyGameActivity:                  CurrentGameActivity;
  package_name:                       Name;
  activity_name:                      Name;
  total_assault_difficulties:         CurrentGameActivity;
  hard_task_student_material:         Array<string[]>;
  student_names:                      StudentName[];
}

export interface Name {
  官服:     string;
  B服:     string;
  国际服:    string;
  国际服青少年: string;
  韩国ONE:  string;
  日服:     string;
}

export interface CommonShopPriceList {
  CN:     Array<CommonShopPriceListCN[]>;
  Global: Array<CommonShopPriceListCN[]>;
  JP:     Array<CommonShopPriceListCN[]>;
}

export type CommonShopPriceListCN = number | string;

export interface CreateDefaultPriority {
  CN:             GlobalKoKrClass;
  Global:         GlobalKoKrClass;
  "Global_zh-tw": GlobalKoKrClass;
  "Global_ko-kr": GlobalKoKrClass;
  JP:             GlobalKoKrClass;
}

export interface GlobalKoKrClass {
  phase1: string[];
  phase2: string[];
  phase3: string[];
}

export interface CreateFilterTypeList {
  CN:     string[];
  Global: string[];
  JP:     string[];
}

export interface CreateItemOrder {
  CN:     CreateItemOrderCN;
  Global: CreateItemOrderCN;
  JP:     CreateItemOrderCN;
}

export interface CreateItemOrderCN {
  basic: Basic;
}

export interface Basic {
  Special:    string[];
  Equipment:  any[];
  Furniture:  any[];
  Decoration: any[];
  Interior:   any[];
  Eleph:      any[];
  Coin:       any[];
  Material:   string[];
  Gift:       any[];
  Disk?:      string[];
  Note?:      string[];
}

export interface CreateMaterialInformation {
  weight:        number;
  availability:  Availability;
  material_type: MaterialType;
}

export interface Availability {
  phase1: boolean;
  phase2: boolean;
  phase3: boolean;
}

export enum MaterialType {
  Material = "Material",
  Special = "Special",
}

export interface CurrentGameActivity {
  CN:     CN;
  Global: Global;
  JP:     Jp;
}

export type CN = PurpleCN[] | number | null;

export type PurpleCN = CommonShopPriceListCN[] | number | string;

export type Global = PurpleCN[] | number | null | string;

export type Jp = PurpleCN[] | number | null | string;

export interface LessonRegionName {
  CN:             string[];
  "Global_en-us": string[];
  "Global_zh-tw": string[];
  "Global_ko-kr": string[];
  JP:             string[];
}

export interface StudentName {
  CN_name:               string;
  CN_implementation:     boolean;
  Global_name:           string;
  Global_implementation: boolean;
  JP_name:               string;
  JP_implementation:     boolean;
}

export class StaticConvert {
  public static toStaticConfig(json: string): StaticConfig {
    return cast(JSON.parse(json), r("StaticConfig"));
  }

  public static staticConfigToJson(value: StaticConfig): string {
    return JSON.stringify(uncast(value, r("StaticConfig")), null, 2);
  }
}

function invalidValue(typ: any, val: any, key: any, parent: any = ''): never {
  const prettyTyp = prettyTypeName(typ);
  const parentText = parent ? ` on ${parent}` : '';
  const keyText = key ? ` for key "${key}"` : '';
  throw Error(`Invalid value${keyText}${parentText}. Expected ${prettyTyp} but got ${JSON.stringify(val)}`);
}

function prettyTypeName(typ: any): string {
  if (Array.isArray(typ)) {
    if (typ.length === 2 && typ[0] === undefined) {
      return `an optional ${prettyTypeName(typ[1])}`;
    } else {
      return `one of [${typ.map(a => { return prettyTypeName(a); }).join(", ")}]`;
    }
  } else if (typeof typ === "object" && typ.literal !== undefined) {
    return typ.literal;
  } else {
    return typeof typ;
  }
}

function jsonToJSProps(typ: any): any {
  if (typ.jsonToJS === undefined) {
    const map: any = {};
    typ.props.forEach((p: any) => map[p.json] = { key: p.js, typ: p.typ });
    typ.jsonToJS = map;
  }
  return typ.jsonToJS;
}

function jsToJSONProps(typ: any): any {
  if (typ.jsToJSON === undefined) {
    const map: any = {};
    typ.props.forEach((p: any) => map[p.js] = { key: p.json, typ: p.typ });
    typ.jsToJSON = map;
  }
  return typ.jsToJSON;
}

function transform(val: any, typ: any, getProps: any, key: any = '', parent: any = ''): any {
  function transformPrimitive(typ: string, val: any): any {
    if (typeof typ === typeof val) return val;
    return invalidValue(typ, val, key, parent);
  }

  function transformUnion(typs: any[], val: any): any {
    // Validate the incoming value against every candidate type until one succeeds.
    const l = typs.length;
    for (let i = 0; i < l; i++) {
      const typ = typs[i];
      try {
        return transform(val, typ, getProps);
      } catch (_) {}
    }
    return invalidValue(typs, val, key, parent);
  }

  function transformEnum(cases: string[], val: any): any {
    if (cases.indexOf(val) !== -1) return val;
    return invalidValue(cases.map(a => { return l(a); }), val, key, parent);
  }

  function transformArray(typ: any, val: any): any {
    // Ensure every element in the array conforms to the declared schema.
    if (!Array.isArray(val)) return invalidValue(l("array"), val, key, parent);
    return val.map(el => transform(el, typ, getProps));
  }

  function transformDate(val: any): any {
    if (val === null) {
      return null;
    }
    const d = new Date(val);
    if (isNaN(d.valueOf())) {
      return invalidValue(l("Date"), val, key, parent);
    }
    return d;
  }

  function transformObject(props: { [k: string]: any }, additional: any, val: any): any {
    if (val === null || typeof val !== "object" || Array.isArray(val)) {
      return invalidValue(l(ref || "object"), val, key, parent);
    }
    const result: any = {};
    Object.getOwnPropertyNames(props).forEach(key => {
      const prop = props[key];
      const v = Object.prototype.hasOwnProperty.call(val, key) ? val[key] : undefined;
      result[prop.key] = transform(v, prop.typ, getProps, key, ref);
    });
    Object.getOwnPropertyNames(val).forEach(key => {
      if (!Object.prototype.hasOwnProperty.call(props, key)) {
        result[key] = transform(val[key], additional, getProps, key, ref);
      }
    });
    return result;
  }

  if (typ === "any") return val;
  if (typ === null) {
    if (val === null) return val;
    return invalidValue(typ, val, key, parent);
  }
  if (typ === false) return invalidValue(typ, val, key, parent);
  let ref: any = undefined;
  while (typeof typ === "object" && typ.ref !== undefined) {
    ref = typ.ref;
    typ = typeMap[typ.ref];
  }
  if (Array.isArray(typ)) return transformEnum(typ, val);
  if (typeof typ === "object") {
    return typ.hasOwnProperty("unionMembers") ? transformUnion(typ.unionMembers, val)
      : typ.hasOwnProperty("arrayItems")    ? transformArray(typ.arrayItems, val)
        : typ.hasOwnProperty("props")         ? transformObject(getProps(typ), typ.additional, val)
          : invalidValue(typ, val, key, parent);
  }
  // Prevent numeric values from being misinterpreted as Date instances.
  if (typ === Date && typeof val !== "number") return transformDate(val);
  return transformPrimitive(typ, val);
}

function cast<T>(val: any, typ: any): T {
  return transform(val, typ, jsonToJSProps);
}

function uncast<T>(val: T, typ: any): any {
  return transform(val, typ, jsToJSONProps);
}

function l(typ: any) {
  return { literal: typ };
}

function a(typ: any) {
  return { arrayItems: typ };
}

function u(...typs: any[]) {
  return { unionMembers: typs };
}

function o(props: any[], additional: any) {
  return { props, additional };
}

function m(additional: any) {
  return { props: [], additional };
}

function r(name: string) {
  return { ref: name };
}

const typeMap: any = {
  "StaticConfig": o([
    { json: "steam_app_process_name", js: "steam_app_process_name", typ: "" },
    { json: "main_story_final_episode_num", js: "main_story_final_episode_num", typ: 0 },
    { json: "main_story_available_episodes", js: "main_story_available_episodes", typ: r("CurrentGameActivity") },
    { json: "max_region", js: "max_region", typ: r("CurrentGameActivity") },
    { json: "explore_normal_task_region_range", js: "explore_normal_task_region_range", typ: a(0) },
    { json: "explore_hard_task_region_range", js: "explore_hard_task_region_range", typ: a(0) },
    { json: "screenshot_methods", js: "screenshot_methods", typ: a("") },
    { json: "control_methods", js: "control_methods", typ: a("") },
    { json: "shop_type_list_names", js: "shop_type_list_names", typ: r("LessonRegionName") },
    { json: "common_shop_price_list", js: "common_shop_price_list", typ: r("CommonShopPriceList") },
    { json: "tactical_challenge_shop_price_list", js: "tactical_challenge_shop_price_list", typ: r("CurrentGameActivity") },
    { json: "create_default_priority", js: "create_default_priority", typ: r("CreateDefaultPriority") },
    { json: "create_each_phase_weight", js: "create_each_phase_weight", typ: a(0) },
    { json: "create_filter_type_list", js: "create_filter_type_list", typ: r("CreateFilterTypeList") },
    { json: "create_item_order", js: "create_item_order", typ: r("CreateItemOrder") },
    { json: "create_phase2_recommended_priority", js: "create_phase2_recommended_priority", typ: m(a(0)) },
    { json: "create_material_information", js: "create_material_information", typ: m(r("CreateMaterialInformation")) },
    { json: "lesson_region_name", js: "lesson_region_name", typ: r("LessonRegionName") },
    { json: "current_game_activity", js: "current_game_activity", typ: r("CurrentGameActivity") },
    { json: "dailyGameActivity", js: "dailyGameActivity", typ: r("CurrentGameActivity") },
    { json: "package_name", js: "package_name", typ: r("Name") },
    { json: "activity_name", js: "activity_name", typ: r("Name") },
    { json: "total_assault_difficulties", js: "total_assault_difficulties", typ: r("CurrentGameActivity") },
    { json: "hard_task_student_material", js: "hard_task_student_material", typ: a(a("")) },
    { json: "student_names", js: "student_names", typ: a(r("StudentName")) },
  ], false),
  "Name": o([
    { json: "官服", js: "官服", typ: "" },
    { json: "B服", js: "B服", typ: "" },
    { json: "国际服", js: "国际服", typ: "" },
    { json: "国际服青少年", js: "国际服青少年", typ: "" },
    { json: "韩国ONE", js: "韩国ONE", typ: "" },
    { json: "日服", js: "日服", typ: "" },
  ], false),
  "CommonShopPriceList": o([
    { json: "CN", js: "CN", typ: a(a(u(0, ""))) },
    { json: "Global", js: "Global", typ: a(a(u(0, ""))) },
    { json: "JP", js: "JP", typ: a(a(u(0, ""))) },
  ], false),
  "CreateDefaultPriority": o([
    { json: "CN", js: "CN", typ: r("GlobalKoKrClass") },
    { json: "Global", js: "Global", typ: r("GlobalKoKrClass") },
    { json: "Global_zh-tw", js: "Global_zh-tw", typ: r("GlobalKoKrClass") },
    { json: "Global_ko-kr", js: "Global_ko-kr", typ: r("GlobalKoKrClass") },
    { json: "JP", js: "JP", typ: r("GlobalKoKrClass") },
  ], false),
  "GlobalKoKrClass": o([
    { json: "phase1", js: "phase1", typ: a("") },
    { json: "phase2", js: "phase2", typ: a("") },
    { json: "phase3", js: "phase3", typ: a("") },
  ], false),
  "CreateFilterTypeList": o([
    { json: "CN", js: "CN", typ: a("") },
    { json: "Global", js: "Global", typ: a("") },
    { json: "JP", js: "JP", typ: a("") },
  ], false),
  "CreateItemOrder": o([
    { json: "CN", js: "CN", typ: r("CreateItemOrderCN") },
    { json: "Global", js: "Global", typ: r("CreateItemOrderCN") },
    { json: "JP", js: "JP", typ: r("CreateItemOrderCN") },
  ], false),
  "CreateItemOrderCN": o([
    { json: "basic", js: "basic", typ: r("Basic") },
  ], false),
  "Basic": o([
    { json: "Special", js: "Special", typ: a("") },
    { json: "Equipment", js: "Equipment", typ: a("any") },
    { json: "Furniture", js: "Furniture", typ: a("any") },
    { json: "Decoration", js: "Decoration", typ: a("any") },
    { json: "Interior", js: "Interior", typ: a("any") },
    { json: "Eleph", js: "Eleph", typ: a("any") },
    { json: "Coin", js: "Coin", typ: a("any") },
    { json: "Material", js: "Material", typ: a("") },
    { json: "Gift", js: "Gift", typ: a("any") },
    { json: "Disk", js: "Disk", typ: u(undefined, a("")) },
    { json: "Note", js: "Note", typ: u(undefined, a("")) },
  ], false),
  "CreateMaterialInformation": o([
    { json: "weight", js: "weight", typ: 0 },
    { json: "availability", js: "availability", typ: r("Availability") },
    { json: "material_type", js: "material_type", typ: r("MaterialType") },
  ], false),
  "Availability": o([
    { json: "phase1", js: "phase1", typ: true },
    { json: "phase2", js: "phase2", typ: true },
    { json: "phase3", js: "phase3", typ: true },
  ], false),
  "CurrentGameActivity": o([
    { json: "CN", js: "CN", typ: u(a(u(a(u(0, "")), 0, "")), 0, null) },
    { json: "Global", js: "Global", typ: u(a(u(a(u(0, "")), 0, "")), 0, null, "") },
    { json: "JP", js: "JP", typ: u(a(u(a(u(0, "")), 0, "")), 0, null, "") },
  ], false),
  "LessonRegionName": o([
    { json: "CN", js: "CN", typ: a("") },
    { json: "Global_en-us", js: "Global_en-us", typ: a("") },
    { json: "Global_zh-tw", js: "Global_zh-tw", typ: a("") },
    { json: "Global_ko-kr", js: "Global_ko-kr", typ: a("") },
    { json: "JP", js: "JP", typ: a("") },
  ], false),
  "StudentName": o([
    { json: "CN_name", js: "CN_name", typ: "" },
    { json: "CN_implementation", js: "CN_implementation", typ: true },
    { json: "Global_name", js: "Global_name", typ: "" },
    { json: "Global_implementation", js: "Global_implementation", typ: true },
    { json: "JP_name", js: "JP_name", typ: "" },
    { json: "JP_implementation", js: "JP_implementation", typ: true },
  ], false),
  "MaterialType": [
    "Material",
    "Special",
  ],
};


