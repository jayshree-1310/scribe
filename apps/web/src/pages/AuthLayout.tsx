import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Logo } from '../components/layout/Logo'
import { Icon } from '../components/ui/Icon'
import { AuthAside } from './AuthAside'
import './auth.css'

interface AuthLayoutProps {
  variant: 'login' | 'register'
  title: string
  subtitle: string
  children: ReactNode
}

/**
 * The shared two-part composition behind /login and /register: an editorial
 * ink panel on the left and the form column on the right. Both pages render
 * the same chrome — back link, brand, login/signup switch, heading — so the
 * two screens stay in step and switching between them barely moves anything
 * on screen.
 */
export function AuthLayout({ variant, title, subtitle, children }: AuthLayoutProps) {
  return (
    <div className="auth">
      <AuthAside variant={variant} />

      <div className="auth__panel">
        <div className="auth__form-wrap">
          <div className="auth__mobile-brand">
            <Logo to="/" />
          </div>

          <Link className="auth__back" to="/">
            <Icon name="arrow-left" size="0.9em" />
            Back to Scribe
          </Link>

          <nav className="auth__switch" aria-label="Sign in or create an account">
            <Link to="/login" aria-current={variant === 'login' ? 'page' : undefined}>
              Sign in
            </Link>
            <Link to="/register" aria-current={variant === 'register' ? 'page' : undefined}>
              Create account
            </Link>
          </nav>

          <header className="auth__head">
            <h1>{title}</h1>
            <p>{subtitle}</p>
          </header>

          {children}
        </div>
      </div>
    </div>
  )
}
