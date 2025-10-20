/**
 * Type definitions for the dynamic configuration payload exchanged between the UI and backend.
 * Regenerate this file alongside the service schema to keep type expectations synchronized.
 */

export interface DynamicConfig {
    name:                                         string;
    purchase_arena_ticket_times:                  string;
    screenshot_interval:                          string;
    autostart:                                    boolean;
    then:                                         string;
    program_address:                              string;
    open_emulator_stat:                           boolean;
    emulator_wait_time:                           string;
    ArenaLevelDiff:                               number;
    ArenaComponentNumber:                         number;
    maxArenaRefreshTimes:                         number;
    createPriority_phase1:                        string;
    createPriority_phase2:                        string;
    createPriority_phase3:                        string;
    create_phase_1_select_item_rule:              string;
    create_phase_2_select_item_rule:              string;
    create_phase_3_select_item_rule:              string;
    create_phase:                                 number;
    create_item_holding_quantity:                 CreateItemHoldingQuantity;
    use_acceleration_ticket:                      boolean;
    createTime:                                   string;
    last_refresh_config_time:                     string;
    alreadyCreateTime:                            string;
    totalForceFightDifficulty:                    string;
    hardPriority:                                 string;
    unfinished_hard_tasks:                        any[];
    mainlinePriority:                             string;
    unfinished_normal_tasks:                      any[];
    main_story_regions:                           string;
    rewarded_task_times:                          string;
    purchase_rewarded_task_ticket_times:          string;
    special_task_times:                           string;
    purchase_scrimmage_ticket_times:              string;
    scrimmage_times:                              string;
    patStyle:                                     string;
    antiHarmony:                                  boolean;
    bannerVisibility:                             boolean;
    push_after_error:                             boolean;
    push_after_completion:                        boolean;
    push_json:                                    string;
    push_serverchan:                              string;
    cafe_reward_affection_pat_round:              number;
    cafe_reward_lowest_affection_first:           boolean;
    cafe_reward_invite1_criterion:                string;
    favorStudent1:                                string[];
    cafe_reward_invite1_starred_student_position: number;
    cafe_reward_has_no2_cafe:                     boolean;
    cafe_reward_collect_hour_reward:              boolean;
    cafe_reward_invite2_criterion:                string;
    favorStudent2:                                string[];
    cafe_reward_invite2_starred_student_position: number;
    cafe_reward_use_invitation_ticket:            boolean;
    cafe_reward_allow_duplicate_invite:           boolean;
    cafe_reward_allow_exchange_student:           boolean;
    cafe_reward_interaction_shot_delay:           number;
    server:                                       string;
    control_method:                               string;
    screenshot_method:                            string;
    adbIP:                                        string;
    adbPort:                                      string;
    lesson_times:                                 number[];
    lesson_enableInviteFavorStudent:              boolean;
    lesson_favorStudent:                          string[];
    lesson_relationship_first:                    boolean;
    lesson_each_region_object_priority:           Array<LessonEachRegionObjectPriority[]>;
    purchase_lesson_ticket_times:                 string;
    explore_normal_task_list:                     string;
    explore_hard_task_list:                       string;
    emulatorIsMultiInstance:                      boolean;
    emulatorMultiInstanceNumber:                  number;
    multiEmulatorName:                            string;
    manual_boss:                                  boolean;
    choose_team_method:                           string;
    side_team_attribute:                          Array<TeamAttribute[]>;
    preset_team_attribute:                        Array<TeamAttribute[]>;
    activity_sweep_task_number:                   number;
    activity_sweep_times:                         string;
    TacticalChallengeShopRefreshTime:             string;
    TacticalChallengeShopList:                    number[];
    CommonShopRefreshTime:                        string;
    CommonShopList:                               number[];
    clear_friend_white_list:                      any[];
    drill_difficulty_list:                        number[];
    drill_fight_formation_list:                   number[];
    drill_enable_sweep:                           boolean;
    new_event_enable_state:                       string;
    ap:                                           Ap;
    creditpoints:                                 BountyCoin;
    pyroxene:                                     BountyCoin;
    tactical_challenge_coin:                      BountyCoin;
    bounty_coin:                                  BountyCoin;
    _pass:                                        Pass;
    assetsVisibility:                             boolean;
    hotkey_run:                                   string;
}

export interface Pass {
    level:                     number;
    max_level:                 number;
    next_level_point:          number;
    next_level_point_required: number;
    weekly_point:              number;
    max_weekly_point:          number;
    time:                      number;
}

export interface Ap {
    count: number;
    max:   number;
    time:  number;
}

export interface BountyCoin {
    count: number;
    time:  number;
}

export interface CreateItemHoldingQuantity {
}

export type LessonEachRegionObjectPriority = "primary" | "normal" | "advanced" | "superior";

export type TeamAttribute = "Unused";

export class DynamicConvert {
    public static toDynamicConfig(json: string): DynamicConfig {
        return cast(JSON.parse(json), r("DynamicConfig"));
    }

    public static dynamicConfigToJson(value: DynamicConfig): string {
        return JSON.stringify(uncast(value, r("DynamicConfig")), null, 2);
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
    "DynamicConfig": o([
        { json: "name", js: "name", typ: "" },
        { json: "purchase_arena_ticket_times", js: "purchase_arena_ticket_times", typ: "" },
        { json: "screenshot_interval", js: "screenshot_interval", typ: "" },
        { json: "autostart", js: "autostart", typ: true },
        { json: "then", js: "then", typ: "" },
        { json: "program_address", js: "program_address", typ: "" },
        { json: "open_emulator_stat", js: "open_emulator_stat", typ: true },
        { json: "emulator_wait_time", js: "emulator_wait_time", typ: "" },
        { json: "ArenaLevelDiff", js: "ArenaLevelDiff", typ: 0 },
        { json: "ArenaComponentNumber", js: "ArenaComponentNumber", typ: 0 },
        { json: "maxArenaRefreshTimes", js: "maxArenaRefreshTimes", typ: 0 },
        { json: "createPriority_phase1", js: "createPriority_phase1", typ: "" },
        { json: "createPriority_phase2", js: "createPriority_phase2", typ: "" },
        { json: "createPriority_phase3", js: "createPriority_phase3", typ: "" },
        { json: "create_phase_1_select_item_rule", js: "create_phase_1_select_item_rule", typ: "" },
        { json: "create_phase_2_select_item_rule", js: "create_phase_2_select_item_rule", typ: "" },
        { json: "create_phase_3_select_item_rule", js: "create_phase_3_select_item_rule", typ: "" },
        { json: "create_phase", js: "create_phase", typ: 0 },
        { json: "create_item_holding_quantity", js: "create_item_holding_quantity", typ: r("CreateItemHoldingQuantity") },
        { json: "use_acceleration_ticket", js: "use_acceleration_ticket", typ: true },
        { json: "createTime", js: "createTime", typ: "" },
        { json: "last_refresh_config_time", js: "last_refresh_config_time", typ: "" },
        { json: "alreadyCreateTime", js: "alreadyCreateTime", typ: "" },
        { json: "totalForceFightDifficulty", js: "totalForceFightDifficulty", typ: "" },
        { json: "hardPriority", js: "hardPriority", typ: "" },
        { json: "unfinished_hard_tasks", js: "unfinished_hard_tasks", typ: a("any") },
        { json: "mainlinePriority", js: "mainlinePriority", typ: "" },
        { json: "unfinished_normal_tasks", js: "unfinished_normal_tasks", typ: a("any") },
        { json: "main_story_regions", js: "main_story_regions", typ: "" },
        { json: "rewarded_task_times", js: "rewarded_task_times", typ: "" },
        { json: "purchase_rewarded_task_ticket_times", js: "purchase_rewarded_task_ticket_times", typ: "" },
        { json: "special_task_times", js: "special_task_times", typ: "" },
        { json: "purchase_scrimmage_ticket_times", js: "purchase_scrimmage_ticket_times", typ: "" },
        { json: "scrimmage_times", js: "scrimmage_times", typ: "" },
        { json: "patStyle", js: "patStyle", typ: "" },
        { json: "antiHarmony", js: "antiHarmony", typ: true },
        { json: "bannerVisibility", js: "bannerVisibility", typ: true },
        { json: "push_after_error", js: "push_after_error", typ: true },
        { json: "push_after_completion", js: "push_after_completion", typ: true },
        { json: "push_json", js: "push_json", typ: "" },
        { json: "push_serverchan", js: "push_serverchan", typ: "" },
        { json: "cafe_reward_affection_pat_round", js: "cafe_reward_affection_pat_round", typ: 0 },
        { json: "cafe_reward_lowest_affection_first", js: "cafe_reward_lowest_affection_first", typ: true },
        { json: "cafe_reward_invite1_criterion", js: "cafe_reward_invite1_criterion", typ: "" },
        { json: "favorStudent1", js: "favorStudent1", typ: a("") },
        { json: "cafe_reward_invite1_starred_student_position", js: "cafe_reward_invite1_starred_student_position", typ: 0 },
        { json: "cafe_reward_has_no2_cafe", js: "cafe_reward_has_no2_cafe", typ: true },
        { json: "cafe_reward_collect_hour_reward", js: "cafe_reward_collect_hour_reward", typ: true },
        { json: "cafe_reward_invite2_criterion", js: "cafe_reward_invite2_criterion", typ: "" },
        { json: "favorStudent2", js: "favorStudent2", typ: a("") },
        { json: "cafe_reward_invite2_starred_student_position", js: "cafe_reward_invite2_starred_student_position", typ: 0 },
        { json: "cafe_reward_use_invitation_ticket", js: "cafe_reward_use_invitation_ticket", typ: true },
        { json: "cafe_reward_allow_duplicate_invite", js: "cafe_reward_allow_duplicate_invite", typ: true },
        { json: "cafe_reward_allow_exchange_student", js: "cafe_reward_allow_exchange_student", typ: true },
        { json: "cafe_reward_interaction_shot_delay", js: "cafe_reward_interaction_shot_delay", typ: 0 },
        { json: "server", js: "server", typ: "" },
        { json: "control_method", js: "control_method", typ: "" },
        { json: "screenshot_method", js: "screenshot_method", typ: "" },
        { json: "adbIP", js: "adbIP", typ: "" },
        { json: "adbPort", js: "adbPort", typ: "" },
        { json: "lesson_times", js: "lesson_times", typ: a(0) },
        { json: "lesson_enableInviteFavorStudent", js: "lesson_enableInviteFavorStudent", typ: true },
        { json: "lesson_favorStudent", js: "lesson_favorStudent", typ: a("") },
        { json: "lesson_relationship_first", js: "lesson_relationship_first", typ: true },
        { json: "lesson_each_region_object_priority", js: "lesson_each_region_object_priority", typ: a(a(r("LessonEachRegionObjectPriority"))) },
        { json: "purchase_lesson_ticket_times", js: "purchase_lesson_ticket_times", typ: "" },
        { json: "explore_normal_task_list", js: "explore_normal_task_list", typ: "" },
        { json: "explore_hard_task_list", js: "explore_hard_task_list", typ: "" },
        { json: "emulatorIsMultiInstance", js: "emulatorIsMultiInstance", typ: true },
        { json: "emulatorMultiInstanceNumber", js: "emulatorMultiInstanceNumber", typ: 0 },
        { json: "multiEmulatorName", js: "multiEmulatorName", typ: "" },
        { json: "manual_boss", js: "manual_boss", typ: true },
        { json: "choose_team_method", js: "choose_team_method", typ: "" },
        { json: "side_team_attribute", js: "side_team_attribute", typ: a(a(r("TeamAttribute"))) },
        { json: "preset_team_attribute", js: "preset_team_attribute", typ: a(a(r("TeamAttribute"))) },
        { json: "activity_sweep_task_number", js: "activity_sweep_task_number", typ: 0 },
        { json: "activity_sweep_times", js: "activity_sweep_times", typ: "" },
        { json: "TacticalChallengeShopRefreshTime", js: "TacticalChallengeShopRefreshTime", typ: "" },
        { json: "TacticalChallengeShopList", js: "TacticalChallengeShopList", typ: a(0) },
        { json: "CommonShopRefreshTime", js: "CommonShopRefreshTime", typ: "" },
        { json: "CommonShopList", js: "CommonShopList", typ: a(0) },
        { json: "clear_friend_white_list", js: "clear_friend_white_list", typ: a("any") },
        { json: "drill_difficulty_list", js: "drill_difficulty_list", typ: a(0) },
        { json: "drill_fight_formation_list", js: "drill_fight_formation_list", typ: a(0) },
        { json: "drill_enable_sweep", js: "drill_enable_sweep", typ: true },
        { json: "new_event_enable_state", js: "new_event_enable_state", typ: "" },
        { json: "ap", js: "ap", typ: r("Ap") },
        { json: "creditpoints", js: "creditpoints", typ: r("BountyCoin") },
        { json: "pyroxene", js: "pyroxene", typ: r("BountyCoin") },
        { json: "tactical_challenge_coin", js: "tactical_challenge_coin", typ: r("BountyCoin") },
        { json: "bounty_coin", js: "bounty_coin", typ: r("BountyCoin") },
        { json: "_pass", js: "_pass", typ: r("Pass") },
        { json: "assetsVisibility", js: "assetsVisibility", typ: true },
        { json: "hotkey_run", js: "hotkey_run", typ: "" },
    ], false),
    "Pass": o([
        { json: "level", js: "level", typ: 0 },
        { json: "max_level", js: "max_level", typ: 0 },
        { json: "next_level_point", js: "next_level_point", typ: 0 },
        { json: "next_level_point_required", js: "next_level_point_required", typ: 0 },
        { json: "weekly_point", js: "weekly_point", typ: 0 },
        { json: "max_weekly_point", js: "max_weekly_point", typ: 0 },
        { json: "time", js: "time", typ: 0 },
    ], false),
    "Ap": o([
        { json: "count", js: "count", typ: 0 },
        { json: "max", js: "max", typ: 0 },
        { json: "time", js: "time", typ: 0 },
    ], false),
    "BountyCoin": o([
        { json: "count", js: "count", typ: 0 },
        { json: "time", js: "time", typ: 0 },
    ], false),
    "CreateItemHoldingQuantity": o([
    ], false),
    "LessonEachRegionObjectPriority": [
        "advanced",
        "normal",
        "primary",
        "superior",
    ],
    "TeamAttribute": [
        "Unused",
    ],
};




