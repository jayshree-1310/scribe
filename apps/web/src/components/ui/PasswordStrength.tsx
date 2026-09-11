import { PASSWORD_RULES, passwordStrength } from '../../lib/auth'
import { cn } from '../../lib/cn'
import { Icon } from './Icon'
import './password-strength.css'

/**
 * The meter and checklist under a new-password field.
 *
 * Lifted out of `RegisterPage` when settings grew its own set-a-password and
 * change-password forms: three copies of the same markup is three places for
 * the rules to drift from `lib/auth.ts`, which is the one thing this is
 * supposed to be showing.
 *
 * The rules are advisory. The API enforces a length and nothing else — see
 * `lib/auth-schemas.ts` for why — so a passphrase that fails three of these
 * is still accepted, and the checklist reads as guidance rather than a gate.
 */
export function PasswordStrength({ value }: { value: string }) {
  const strength = passwordStrength(value)

  return (
    <div className="strength">
      <div className="strength__meter" aria-hidden="true">
        {[1, 2, 3, 4].map((step) => (
          <span
            key={step}
            className={cn(
              'strength__step',
              strength.score >= step && `is-on is-level-${strength.score}`,
            )}
          />
        ))}
      </div>
      <p className="strength__label" aria-live="polite">
        {strength.label}
      </p>
      <ul className="strength__rules">
        {PASSWORD_RULES.map((rule) => {
          const met = strength.passed.includes(rule.id)
          return (
            <li key={rule.id} className={cn(met && 'is-met')}>
              <Icon name={met ? 'check-circle' : 'minus'} size="0.85em" />
              {rule.label}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
