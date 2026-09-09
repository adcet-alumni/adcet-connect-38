import { NavLink as RouterNavLink, NavLinkProps } from "react-router-dom";
import { forwardRef, useCallback } from "react";
import { cn } from "@/lib/utils";
import { preloadRoute } from "@/lib/routePreload";

interface NavLinkCompatProps extends Omit<NavLinkProps, "className"> {
  className?: string;
  activeClassName?: string;
  pendingClassName?: string;
}

const NavLink = forwardRef<HTMLAnchorElement, NavLinkCompatProps>(
  ({ className, activeClassName, pendingClassName, to, onMouseEnter, onFocus, ...props }, ref) => {
    /**
     * Fetch the destination's chunk on intent.
     *
     * Every route in the app is code-split, so a first click otherwise waits on
     * a network round trip. A hover or a Tab landing on the link is roughly
     * 200 ms of warning, which is usually the whole of it — and the fetch is
     * idempotent, so repeatedly grazing a link costs nothing after the first.
     */
    const prefetch = useCallback(() => {
      if (typeof to === "string") preloadRoute(to);
    }, [to]);

    return (
      <RouterNavLink
        ref={ref}
        to={to}
        onMouseEnter={(e) => {
          prefetch();
          onMouseEnter?.(e);
        }}
        onFocus={(e) => {
          prefetch();
          onFocus?.(e);
        }}
        className={({ isActive, isPending }) =>
          cn(className, isActive && activeClassName, isPending && pendingClassName)
        }
        {...props}
      />
    );
  },
);

NavLink.displayName = "NavLink";

export { NavLink };
