import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { V75Analyzer } from "@/components/v75/V75Analyzer";

const queryClient = new QueryClient();

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <V75Analyzer />
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
