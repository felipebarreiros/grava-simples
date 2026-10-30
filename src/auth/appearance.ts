import type { Appearance } from '@clerk/ui';
import { dark } from '@clerk/ui/themes';
import './clerk.css';

// Clerk's neutral palette is independent of its foreground palette. Starting
// from its dark theme also covers portal menus and account-management dialogs.
const colors = {
  background: '#1e1e1e',
  foreground: '#f5f3ef',
  muted: '#2d2d2d',
  mutedForeground: '#c4c1ba',
  input: '#151515',
  primary: '#ff4000',
  primaryForeground: '#1a100b',
  border: '#757575',
  ring: '#ff865e',
  danger: '#ff9b90',
} as const;

const focusRing = {
  outline: `2px solid ${colors.ring}`,
  outlineOffset: '3px',
};

const outlinedControl = {
  color: colors.foreground,
  backgroundColor: '#292929',
  border: `1px solid ${colors.border}`,
  '&:hover': {
    color: colors.foreground,
    backgroundColor: '#333333',
    borderColor: '#999999',
  },
  '&:focus-visible': focusRing,
};

const accountForm = {
  rootBox: { width: '448px', maxWidth: '100%' },
  cardBox: { width: '100%', maxWidth: '100%' },
};

export const clerkAppearance = {
  theme: dark,
  options: { socialButtonsVariant: 'blockButton' },
  variables: {
    colorBackground: colors.background,
    colorForeground: colors.foreground,
    colorNeutral: colors.foreground,
    colorMuted: colors.muted,
    colorMutedForeground: colors.mutedForeground,
    colorInput: colors.input,
    colorInputForeground: colors.foreground,
    colorPrimary: colors.primary,
    colorPrimaryForeground: colors.primaryForeground,
    colorBorder: colors.border,
    colorRing: colors.ring,
    colorDanger: colors.danger,
    colorSuccess: '#9be1b4',
    colorWarning: '#ffd18a',
    colorModalBackdrop: 'rgba(0, 0, 0, 0.76)',
    colorShadow: '#000000',
    fontFamily: '"DM Sans", sans-serif',
    fontFamilyButtons: '"DM Sans", sans-serif',
    // Explicit sizes keep the studio's compact 14px root from shrinking Clerk.
    fontSize: { xs: '13px', sm: '14px', md: '16px', lg: '22px', xl: '28px' },
    spacing: '16px',
    borderRadius: '8px',
  },
  elements: {
    cardBox: {
      backgroundColor: colors.background,
      border: '1px solid #484848',
      borderRadius: '16px',
      boxShadow: '0 20px 64px rgba(0, 0, 0, 0.32)',
    },
    card: { padding: '32px', margin: 0, border: 0, borderRadius: 0, gap: '28px' },
    headerTitle: { fontSize: '28px', fontWeight: 650, lineHeight: '1.2', letterSpacing: '-0.6px' },
    headerSubtitle: { fontSize: '15px', lineHeight: '1.6', color: colors.mutedForeground },
    formFieldLabel: { fontSize: '14px', fontWeight: 550 },
    formFieldInput: {
      minHeight: '48px', fontSize: '16px', lineHeight: '1.5',
      padding: '11px 14px', borderRadius: '8px',
    },
    formButtonPrimary: { minHeight: '48px', fontSize: '16px', fontWeight: 650, borderRadius: '8px' },
    footer: { background: colors.background, backgroundImage: 'none', marginTop: 0, paddingTop: 0 },
    footerAction: {
      padding: '20px 24px', borderTop: '1px solid #3b3b3b',
      flexWrap: 'wrap', justifyContent: 'center', gap: '6px',
    },
    footerActionText: { fontSize: '14px', color: colors.mutedForeground },
    footerActionLink: { fontSize: '14px', fontWeight: 600, color: '#ffab8d', whiteSpace: 'nowrap' },
    socialButtons: { gridTemplateColumns: '1fr' },
    navbarButton: {
      color: colors.foreground,
      '&[data-active="true"], &:hover, &:focus': { color: colors.foreground },
      '&:focus-visible': focusRing,
    },
    button: {
      '&:focus-visible': focusRing,
      '&[data-variant="outline"]': outlinedControl,
      // Clerk's destructive and neutral solid buttons use white text by
      // default. Their light dark-theme fills need the same ink as primary.
      '&[data-variant="solid"][data-color="danger"]': {
        color: colors.primaryForeground,
        '&:hover': { color: colors.primaryForeground },
      },
      '&[data-variant="solid"][data-color="neutral"]': {
        color: colors.primaryForeground,
        '&:hover': { color: colors.primaryForeground },
      },
    },
    input: {
      backgroundColor: colors.input,
      '&::placeholder': { color: colors.mutedForeground, opacity: 1 },
      // The SDK's default variant otherwise replaces borders with a faint
      // shadow. Match that selector so fields retain a clear visible boundary.
      '&[data-variant="default"]': {
        borderWidth: '1px', borderStyle: 'solid', borderColor: colors.border, boxShadow: 'none',
        '&:hover': { borderColor: '#999999', boxShadow: 'none' },
        '&:focus, &:focus-visible': { ...focusRing, borderColor: colors.ring, boxShadow: 'none' },
        '&[aria-invalid="true"]': { borderColor: colors.danger },
      },
    },
    badge: {
      '&[data-color="primary"]': {
        color: colors.mutedForeground, backgroundColor: colors.muted, borderColor: '#585858',
      },
    },
    socialButtonsBlockButton: {
      ...outlinedControl, minHeight: '48px', fontSize: '16px',
      fontWeight: 550, borderRadius: '8px', padding: '12px 16px',
    },
    socialButtonsBlockButtonText: { fontSize: '16px' },
    socialButtonsProviderIcon: { width: '20px', height: '20px' },
    socialButtonsIconButton: outlinedControl,
    userButtonPopoverCard: { border: '1px solid #484848', borderRadius: '12px' },
    userButtonPopoverActionButton: {
      color: colors.foreground,
      fontSize: '16px', minHeight: '48px', padding: '12px 20px',
      '&:hover': {
        color: colors.foreground,
        backgroundColor: colors.muted,
      },
      '&:focus-visible': focusRing,
    },
  },
  signIn: { elements: accountForm },
  signUp: { elements: accountForm },
} satisfies Appearance;
