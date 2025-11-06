let x = true;
let y = false;
let a = x && y;
let b = x || y;
let c = x ?? y;
let d = !x;
let e = !!x;

let chain1 = 1 && 2 && 3 && global;
let chain2 = (1 && 2 && global) || 3 || 4;
let resolve1 = 1 && 2 && global && 3 && 4;
let resolve2 = 1 && 2 && 0 && global && 4;
let resolve3 = global || true;
let resolve4 = true || global;
let resolve5 = global && false;
let resolve6 = false && global;

// Optional chaining tests
let opt1 = obj?.prop;
let opt2 = obj?.method();
let opt3 = obj?.prop.nested;
let opt4 = obj?.prop?.nested;
let opt5 = obj?.method()?.result;
let opt6 = obj?.prop?.method?.().result;
let opt7 = obj?.[computed];
let opt8 = obj?.[computed]?.nested;

// Optional chaining with known null/undefined values
let nullValue = null;
let undefinedValue = undefined;
let opt9 = nullValue?.prop;
let opt10 = undefinedValue?.prop;
let opt11 = nullValue?.method();
let opt12 = null?.prop;
let opt13 = undefined?.prop;
