import type { RemoteUser } from '../hooks/useYjsDocument.js'

export function PresenceBar({ users, selfName }: { users: RemoteUser[]; selfName: string }) {
  return (
    <div className="flex items-center gap-1 px-3 py-2 border-b border-border">
      <span className="text-xs text-muted-foreground mr-1">Online:</span>
      {/* Self */}
      <Avatar name={selfName} color="#6366f1" title="You" />
      {users.map((u) => (
        <Avatar key={u.id} name={u.name} color={u.color} title={u.name} />
      ))}
    </div>
  )
}

function Avatar({ name, color, title }: { name: string; color: string; title: string }) {
  return (
    <div
      title={title}
      className="w-6 h-6 rounded-full flex items-center justify-center text-white text-xs font-bold flex-shrink-0 cursor-default"
      style={{ backgroundColor: color }}
    >
      {name.slice(0, 1).toUpperCase()}
    </div>
  )
}
