type StatusCardProps = {
  title: string;
  value: string;
  subtitle: string;
};

export function StatusCard({ title, value, subtitle }: StatusCardProps) {
  return (
    <section className="panel">
      <h3>{title}</h3>
      <div className="status-line">
        <span className="status-pill">{value}</span>
      </div>
      <p className="muted">{subtitle}</p>
    </section>
  );
}

