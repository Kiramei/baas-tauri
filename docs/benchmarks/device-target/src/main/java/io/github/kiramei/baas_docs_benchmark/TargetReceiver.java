package io.github.kiramei.baas_docs_benchmark;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public final class TargetReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (!"io.github.kiramei.baas_docs_benchmark.SET_STATE".equals(intent.getAction())) return;
        MainActivity.applyState(intent.getIntExtra("token", -1), intent.getIntExtra("scene", -1),
                intent.getBooleanExtra("reset", false));
        MainActivity.writeSnapshot(context);
    }
}
