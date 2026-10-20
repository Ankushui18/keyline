import { useEffect, type RefObject } from 'react';

const FOCUSABLE = 'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** Keep modal keyboard focus inside, hide background controls, and restore the opener. */
export function useModalFocus(ref: RefObject<HTMLElement>, resetKey?: unknown): void {
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () => [...root.querySelectorAll<HTMLElement>(FOCUSABLE)]
      .filter((element) => element.getClientRects().length > 0 && !element.closest('[inert]'));
    const focusFirst = () => {
      const target = root.querySelector<HTMLElement>('[autofocus], [aria-label="Close"]') ?? focusable()[0];
      if (target) target.focus();
      else { root.tabIndex = -1; root.focus(); }
    };
    focusFirst();

    const background: Array<{ element: HTMLElement; inert: boolean; hidden: string | null }> = [];
    let branch: HTMLElement = root;
    while (branch.parentElement) {
      for (const sibling of branch.parentElement.children) {
        if (sibling instanceof HTMLElement && sibling !== branch) {
          background.push({ element: sibling, inert: sibling.inert, hidden: sibling.getAttribute('aria-hidden') });
          sibling.inert = true;
          sibling.setAttribute('aria-hidden', 'true');
        }
      }
      if (branch.parentElement === document.body) break;
      branch = branch.parentElement;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || event.defaultPrevented) return;
      const elements = focusable();
      const first = elements[0]; const last = elements[elements.length - 1];
      if (!first) { event.preventDefault(); return; }
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !root.contains(active))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (active === last || !root.contains(active))) {
        event.preventDefault(); first.focus();
      }
    };
    const onFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !root.contains(event.target)) focusFirst();
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('focusin', onFocus);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('focusin', onFocus);
      for (const { element, inert, hidden } of background) {
        element.inert = inert;
        if (hidden === null) element.removeAttribute('aria-hidden');
        else element.setAttribute('aria-hidden', hidden);
      }
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [ref, resetKey]);
}
