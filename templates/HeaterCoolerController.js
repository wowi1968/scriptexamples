// @template HeaterCoolerController
// @templateName Heating/cooling controller
// @templateName.de Regler Heizen/Kühlen
// Heating/cooling controller (like the standard node "Controller Heat/Cool"): a PI controller limited to 0 ... 100
// with e = setPoint - input for Heat and input - setPoint for Cool, and a pulse width modulation: within each
// pulseWidth period, pulseWidthModulation is true for output percent of the period (the standard node's modulation
// never works: it is always on while output > 0). isActive becomes true when e >= 0 and false when the set point
// changes and e < 0; while not active, output is 0. Timeout as in the PI controller.
// enabled false: output 0, a reset of the integral, modulation off.
// @inputs 4
// @input1 setPoint: number
// @input2 input: number
// @input3 enabled: bool = true
// @input4 restart: bool = false
// @params 7
// @param1 proportionalBand: number = 4 [0.0001..100]
// @param2 resetTime: timespan = 120min
// @param3 timeout: timespan = 60min
// @param4 timeoutMode: string = "Continue"
// @param5 fallbackValue: number = 0 [0..100]
// @param6 controlMode: string = "Heat"
// @param7 pulseWidth: timespan = 15min
// @outputs 4
// @output1 output: number [0..100]
// @output2 timeoutSignal: bool
// @output3 pulseWidthModulation: bool
// @output4 isActive: bool
const s = node.state;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const period = Math.max(60000, pulseWidth);
const error = () => (controlMode === 'Cool' ? input - setPoint : setPoint - input);
const reset = () => {
  s.sum = 0;
  s.last = null;
};
const compute = () => {
  const kp = 100 / proportionalBand;
  const ki = kp / (Math.max(1000, resetTime) / 1000);
  const e = error();
  const now = node.now();
  const integral = s.last == null ? 0 : clamp(s.sum + ((now - s.last) / 1000) * e, -100 / ki, 100 / ki);
  const out = clamp(kp * e + ki * integral, 0, 100);
  s.last = now;
  if (s.active && !(out === 0 && e <= 0)) {
    s.sum = integral;
    s.output = out;
  } else {
    s.sum = 0;
    s.output = 0;
  }
  return s.output;
};
// One modulation period: on for output percent of it, from its start.
const modulate = () => {
  const on = s.output > 0;
  if (on && s.output < 100) node.after(Math.max(50, (s.output / 100) * period), 'pwmOff');
  else node.cancel('pwmOff');
  return on;
};

if (node.trigger === 'startup') {
  s.enabled = enabled;
  s.active = false;
  s.output = 0;
  reset();
  node.every(period, 'pwm');
  return;
}

if (node.trigger === 'timer') {
  if (node.timer === 'pwm') return s.enabled ? { pulseWidthModulation: modulate() } : undefined;
  if (node.timer === 'pwmOff') return { pulseWidthModulation: false };
  const result = { timeoutSignal: true };
  if (timeoutMode === 'Continue') result.output = compute();
  else if (timeoutMode === 'Fallback') result.output = fallbackValue;
  if (timeoutMode !== 'Discontinue') node.after(Math.max(1000, timeout), 'timeout');
  return result;
}

if (node.changed.includes('enabled')) {
  if (enabled && !s.enabled) s.enabled = true;
  else if (!enabled && s.enabled) {
    node.cancel('timeout');
    node.cancel('pwmOff');
    reset();
    s.enabled = false;
    s.active = false;
    s.output = 0;
    return { output: 0, timeoutSignal: false, isActive: false, pulseWidthModulation: false };
  }
}
if (!s.enabled) return;
const result = {};
const e = error();
if (!s.active && e >= 0) result.isActive = s.active = true;
else if (s.active && node.changed.includes('setPoint') && s.setPoint !== undefined && s.setPoint !== setPoint && e < 0) {
  result.isActive = s.active = false;
}
if (node.changed.includes('setPoint')) s.setPoint = setPoint;
if (node.changed.includes('restart') && restart) reset();
const newInput = node.changed.includes('input');
if (!(newInput || node.changed.includes('setPoint'))) return result;
if (newInput) {
  result.timeoutSignal = false;
  node.after(Math.max(1000, timeout), 'timeout');
}
result.output = compute();
return result;