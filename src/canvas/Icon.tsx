import { icons, type LucideProps } from "lucide-react";

const pascal = (name: string) =>
  name.replace(/(^|-)([a-z0-9])/g, (_, __, c: string) => c.toUpperCase());

/** Lucide icon by kebab-case name (UHD display hints use Lucide names). */
export function Icon({ name, ...props }: { name: string } & LucideProps) {
  const Component = icons[pascal(name) as keyof typeof icons] ?? icons.Box;
  return <Component {...props} />;
}
