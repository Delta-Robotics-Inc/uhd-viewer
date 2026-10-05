/**
 * The plain standalone app: the library's views in the app's chrome, themed
 * by the viewer's own themes (or the host's, through `theme`).
 */
import { useMemo } from "react";
import { ThemeProvider } from "../theme/ThemeProvider";
import { resolveTheme } from "../theme/resolve";
import { UhdViewer, useViewer, type AppProps } from "../viewer/controller";
import { DiagramCanvas, Scene3D, ViewerInspector, ViewerNodeMenu } from "../viewer/views";
import { ActivityBar, Header } from "./Chrome";

export default function App(props: AppProps) {
  const adapter = useMemo(() => resolveTheme(props.theme), [props.theme]);
  return (
    <ThemeProvider adapter={adapter}>
      <UhdViewer {...props}>
        <Shell />
      </UhdViewer>
    </ThemeProvider>
  );
}

function Shell() {
  const c = useViewer();
  return (
    <div className="app">
      <Header
        vm={c.vm}
        onNavigate={c.onNavigate}
        scenarios={c.scenarios}
        scenario={c.scenario.id}
        onScenario={c.onScenario}
        view={c.view}
        onView={c.setView}
      />
      <div className="workspace">
        <ActivityBar panel={c.panel} onPanel={c.setPanel} errors={c.errors} />
        {c.view === "3d" ? (
          <Scene3D />
        ) : (
          <>
            <DiagramCanvas />
            <ViewerInspector />
          </>
        )}
      </div>
      <ViewerNodeMenu />
    </div>
  );
}
