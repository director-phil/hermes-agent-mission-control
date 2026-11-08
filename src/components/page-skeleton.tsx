export default function PageSkeleton() {
  return (
    <div className="p-6 space-y-6">
      <div className="sk h-8 w-64 rounded" />
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {[...Array(6)].map((_, i) => (
          <div key={i} className="panel p-5 space-y-3">
            <div className="sk h-3 w-24 rounded" />
            <div className="sk h-3 w-full rounded" />
            <div className="sk h-3 w-4/5 rounded" />
          </div>
        ))}
      </div>
    </div>
  );
}
