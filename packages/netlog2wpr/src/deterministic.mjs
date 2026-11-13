/**
 * Replaces the deterministic.js placeholders exactly like wpr's
 * replaceConstants (legacy {{X}} form first, then the bare form).
 * @param {string} script source of deterministic.js
 * @param {number} timeSeedMs WPR_TIME_SEED_TIMESTAMP value
 * @param {number|null} [constantMathRandomResult] Math.random result archived
 *   as ConstantMathRandomResult; absent/null renders as null
 * @returns {string}
 */
export const renderDeterministicScript = (script, timeSeedMs, constantMathRandomResult) => {
  const randomResultStr = constantMathRandomResult === undefined || constantMathRandomResult === null
    ? 'null'
    : String(constantMathRandomResult)
  const timeSeedTimestamp = String(timeSeedMs)
  return script
    .replaceAll('{{WPR_TIME_SEED_TIMESTAMP}}', timeSeedTimestamp)
    .replaceAll('{{WPR_CONSTANT_RANDOM_RESULT}}', randomResultStr)
    .replaceAll('WPR_TIME_SEED_TIMESTAMP', timeSeedTimestamp)
    .replaceAll('WPR_CONSTANT_RANDOM_RESULT', randomResultStr)
}
