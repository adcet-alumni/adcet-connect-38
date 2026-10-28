import { Link } from "react-router-dom";
import { ArrowRight, Loader2 } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import Marquee from "@/components/public/Marquee";
import { esteemedAlumniQuery, esteemedAlumnusPhotoUrl } from "@/lib/esteemed";

/**
 * Sliding row of esteemed alumni; every card opens the full listing.
 *
 * Renders the whole roster in sortOrder, so the strip leads with the
 * most senior alumni and mixes departments on its own.
 */
export default function EsteemedStrip() {
  const { data: alumni = [], isLoading } = useQuery(esteemedAlumniQuery());

  if (isLoading) {
    return (
      <section className="py-16 bg-card border-y border-border flex justify-center items-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </section>
    );
  }

  if (alumni.length === 0) return null;

  return (
    <section className="py-16 bg-card border-y border-border">
      <div className="max-w-5xl mx-auto px-6 text-center mb-10">
        <h2 className="text-2xl sm:text-3xl font-bold mb-3">Esteemed Alumni</h2>
        <div className="w-16 h-0.5 bg-primary/50 mx-auto mb-4" />
        <p className="text-sm text-muted-foreground max-w-2xl mx-auto">
          Graduates whose work in industry, enterprise and public service carries the ADCET name forward.
        </p>
      </div>

      <Marquee durationSec={100}>
        {alumni.map((a) => (
          <Link
            key={a.id}
            to="/esteemed-alumni"
            className="w-[200px] mx-4 shrink-0 text-center group/card"
            title={`${a.name} (Batch of ${a.batch}) — ${a.position}`}
          >
            <img
              src={esteemedAlumnusPhotoUrl(a)}
              alt={a.name}
              loading="lazy"
              className="w-40 h-40 mx-auto rounded-full object-cover object-top ring-2 ring-border shadow-sm
                transition-all group-hover/card:ring-primary/50 group-hover/card:shadow-md"
            />
            <p className="mt-4 text-sm font-semibold text-foreground leading-snug group-hover/card:text-primary transition-colors">
              {a.name}
            </p>
            <p className="text-xs font-medium text-primary leading-snug mt-0.5">Batch of {a.batch}</p>
            <p className="text-xs text-muted-foreground leading-snug mt-1 line-clamp-2">{a.position}</p>
          </Link>
        ))}
      </Marquee>

      <div className="text-center mt-10">
        <Link
          to="/esteemed-alumni"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
        >
          Meet all our esteemed alumni <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>
    </section>
  );
}
